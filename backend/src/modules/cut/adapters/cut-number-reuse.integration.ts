import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import { allocateCutJobSourceDisplayNumber } from './cut-job-display-number';
import { ensureSvgCutJobDisplayNumberAvailable, syncSvgCutJobSourceDisplayNumber } from '../../cnc-telegram/adapters/pg-cnc-telegram-repository';
import { replaceUnconfirmedImportDraft } from '../../cnc-telegram/adapters/pg-cnc-telegram-import-repository';

const databaseUrl = process.env.CUT_INTEGRATION_DATABASE_URL;
const schema = `e2e_cut_number_${randomUUID().replaceAll('-', '_')}`;
const migration = readFileSync(new URL('../../../../db/migrations/148_cut_job_number_reuse.sql', import.meta.url), 'utf8');
const txFor = (client: PoolClient): TransactionClient => ({
  raw: client,
  query: (sql, params) => client.query(sql, params ? [...params] : undefined),
});

describe.skipIf(!databaseUrl)('cut number reuse: actual PostgreSQL migration and assignment', () => {
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE cut_job (
        cut_job_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source_display_number TEXT, status TEXT NOT NULL DEFAULT 'ready', updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_cut_job_source_display_number ON cut_job ((NULLIF(btrim(source_display_number), '')))
        WHERE NULLIF(btrim(source_display_number), '') IS NOT NULL;
      CREATE TABLE cnc_telegram_import_items (
        import_item_id BIGINT, import_request_id TEXT, status TEXT,
        error_code TEXT, error_message TEXT, updated_at TIMESTAMPTZ
      );
      CREATE TABLE cnc_telegram_import_requests (
        import_request_id TEXT PRIMARY KEY, requested_by TEXT, scan_id TEXT, status TEXT,
        confirmation_id TEXT, confirmed_at TIMESTAMPTZ, repeat_of_import_request_id TEXT,
        error_code TEXT, error_message TEXT, failed_count INTEGER, selected_count INTEGER, completed_at TIMESTAMPTZ,
        selection_hash TEXT
      );
      CREATE UNIQUE INDEX active_selection ON cnc_telegram_import_requests (scan_id,requested_by,selection_hash)
        WHERE status IN ('draft','pending','processing');
      INSERT INTO cut_job (source_display_number, status) VALUES ('42', 'archived'), ('43', 'ready'), ('В-42', 'archived');
    `);
    await pool.query(migration);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const residue = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
      expect(residue.rowCount).toBe(0);
      await admin.end();
    }
  });

  it('retains archived history, permits reuse in both series, blocks active duplicates and conflicting restore', async () => {
    const runner = readFileSync(new URL('../../../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
    const arm = runner.slice(runner.indexOf('148_cut_job_number_reuse*)'), runner.indexOf('*) return 2'));
    const probe = arm.match(/"(SELECT EXISTS \([\s\S]*?\);)"/)?.[1];
    expect(probe).toBeTruthy();
    expect((await pool.query(probe!.replace('public.uq_cut_job_source_display_number', `${schema}.uq_cut_job_source_display_number`))).rows[0].exists).toBe(true);
    await pool.query("INSERT INTO cut_job (source_display_number) VALUES ('42'), ('В-42')");
    await expect(pool.query("INSERT INTO cut_job (source_display_number) VALUES (' 42 ')")).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query("UPDATE cut_job SET status='ready' WHERE cut_job_id=1")).rejects.toMatchObject({ code: '23505' });
    expect((await pool.query('SELECT source_display_number,status FROM cut_job WHERE cut_job_id=1')).rows[0])
      .toEqual({ source_display_number: '42', status: 'archived' });
    await pool.query("UPDATE cut_job SET status='archived' WHERE source_display_number='43'");
    await pool.query("INSERT INTO cut_job (source_display_number) VALUES ('43')");
  });

  it('allows only one concurrent active assignment, even without application locks', async () => {
    const results = await Promise.allSettled([
      pool.query("INSERT INTO cut_job (source_display_number) VALUES ('99')"),
      pool.query("INSERT INTO cut_job (source_display_number) VALUES ('99')"),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: '23505' } });
  });

  it('server checks ignore archived rows and historical replay cannot rewrite them', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO cut_job (source_display_number,status) VALUES ('110','archived')");
      await expect(ensureSvgCutJobDisplayNumberAvailable(txFor(client), '110', null)).resolves.toBeUndefined();
      await expect(ensureSvgCutJobDisplayNumberAvailable(txFor(client), '42', null)).rejects.toMatchObject({ code: 'CUT_JOB_NUMBER_CONFLICT' });
      await syncSvgCutJobSourceDisplayNumber(txFor(client), 1, '43');
      expect((await client.query('SELECT source_display_number FROM cut_job WHERE cut_job_id=1')).rows[0].source_display_number).toBe('42');
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('automatic allocation stays above historical numbers and persists safe manual values', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO cut_job (source_display_number,status) VALUES ('3000000000','archived')");
      await expect(allocateCutJobSourceDisplayNumber(txFor(client), 'regular')).resolves.toBe('3000000001');
      await client.query('INSERT INTO cnc_telegram_import_items (requested_cut_job_id) VALUES (3000000000)');
      expect((await client.query('SELECT requested_cut_job_id FROM cnc_telegram_import_items')).rows[0].requested_cut_job_id).toBe('3000000000');
      await client.query('ROLLBACK');
      await expect(client.query('INSERT INTO cnc_telegram_import_items (requested_cut_job_id) VALUES (0)')).rejects.toMatchObject({ code: '23514' });
    } finally { client.release(); }
  });

  it('replaces only an untouched draft, releasing active selection without changing frozen numbers', async () => {
    const client = await pool.connect();
    const input = { importRequestId: 'draft-1', confirmationId: 'confirm-1', actorUserId: '1', scanId: 'scan-1', repeatOfImportRequestId: null };
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO cnc_telegram_import_requests (import_request_id,requested_by,scan_id,status,confirmation_id,selected_count,selection_hash) VALUES ('draft-1','1','scan-1','draft','confirm-1',1,'same-selection')");
      await client.query("INSERT INTO cnc_telegram_import_items (import_request_id,status,requested_cut_job_id) VALUES ('draft-1','pending',42)");
      await expect(replaceUnconfirmedImportDraft(txFor(client), { ...input, confirmationId: 'stale' })).rejects.toMatchObject({ code: 'CNC_TELEGRAM_DRAFT_STALE' });
      await replaceUnconfirmedImportDraft(txFor(client), input);
      await client.query("INSERT INTO cnc_telegram_import_requests (import_request_id,requested_by,scan_id,status,selection_hash) VALUES ('replacement','1','scan-1','draft','same-selection')");
      expect((await client.query("SELECT status,requested_cut_job_id FROM cnc_telegram_import_items WHERE import_request_id='draft-1'")).rows[0])
        .toEqual({ status: 'failed', requested_cut_job_id: '42' });
      await expect(replaceUnconfirmedImportDraft(txFor(client), input)).rejects.toMatchObject({ code: 'CNC_TELEGRAM_DRAFT_STALE' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('a concurrent confirmation prevents draft replacement', async () => {
    await pool.query("INSERT INTO cnc_telegram_import_requests (import_request_id,requested_by,scan_id,status,confirmation_id,selected_count,selection_hash) VALUES ('confirm-race','1','scan-1','draft','confirm-race',1,'race')");
    const confirm = await pool.connect(); const replace = await pool.connect();
    try {
      await confirm.query('BEGIN'); await replace.query('BEGIN');
      await confirm.query("SELECT * FROM cnc_telegram_import_requests WHERE import_request_id='confirm-race' FOR SHARE");
      const outcome = replaceUnconfirmedImportDraft(txFor(replace), {
        importRequestId: 'confirm-race', confirmationId: 'confirm-race', actorUserId: '1', scanId: 'scan-1', repeatOfImportRequestId: null,
      }).then(() => null, (error) => error);
      await confirm.query("UPDATE cnc_telegram_import_requests SET status='pending',confirmed_at=now() WHERE import_request_id='confirm-race'");
      await confirm.query('COMMIT');
      expect(await outcome).toMatchObject({ code: 'CNC_TELEGRAM_DRAFT_STALE' });
      await replace.query('ROLLBACK');
      expect((await pool.query("SELECT status FROM cnc_telegram_import_requests WHERE import_request_id='confirm-race'")).rows[0].status).toBe('pending');
    } finally { confirm.release(); replace.release(); }
  });

  it('number conflict rolls back replacement and reconfirmation drafts cannot be replaced', async () => {
    await pool.query("INSERT INTO cnc_telegram_import_requests (import_request_id,requested_by,scan_id,status,confirmation_id,selected_count,selection_hash) VALUES ('rollback-draft','1','scan-1','draft','confirm-1',1,'rollback')");
    const client = await pool.connect();
    const input = { importRequestId: 'rollback-draft', confirmationId: 'confirm-1', actorUserId: '1', scanId: 'scan-1', repeatOfImportRequestId: null };
    try {
      await client.query('BEGIN');
      await replaceUnconfirmedImportDraft(txFor(client), input);
      await expect(ensureSvgCutJobDisplayNumberAvailable(txFor(client), '42', null)).rejects.toMatchObject({ code: 'CUT_JOB_NUMBER_CONFLICT' });
      await client.query('ROLLBACK');
      expect((await client.query("SELECT status FROM cnc_telegram_import_requests WHERE import_request_id='rollback-draft'")).rows[0].status).toBe('draft');
      await client.query("UPDATE cnc_telegram_import_requests SET confirmed_at=now() WHERE import_request_id='rollback-draft'");
      await expect(replaceUnconfirmedImportDraft(txFor(client), input)).rejects.toMatchObject({ code: 'CNC_TELEGRAM_DRAFT_STALE' });
    } finally { client.release(); }
  });
});
