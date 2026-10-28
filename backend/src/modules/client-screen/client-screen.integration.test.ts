import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { PermissionsService } from '../../permissions/permissions.service';
import { CLIENT_SCREEN_DEFAULT_VISIBLE_CODES, type ClientScreenCode } from './client-screen.registry';
import { ClientScreenRepository } from './client-screen.repository';
import { ClientScreenService } from './client-screen.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '11', username: 'screen-admin', role: 'admin', roleId: 1, permissions: ['settings.manage'] };
const manager: CurrentUser = { id: '12', username: 'screen-manager', role: 'manager', roleId: 2, permissions: ['orders.view'] };

describe.skipIf(!databaseUrl)('client screen settings (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_screen_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let repository: ClientScreenRepository;
  let service: ClientScreenService;
  /** The row exactly as the migration left it, read before any test touches it. */
  let migrated: Array<Record<string, unknown>>;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  // The migration names the public schema; the test runs it inside its own schema.
  const migration = async () => (await readFile(new URL('../../../db/migrations/241_client_screen_settings.sql', import.meta.url), 'utf8')).replaceAll('public.', '');
  const row = async () => (await q<{ enabled: boolean; visible_codes: string[]; version: string; updated_by_user_id: string | null }>(
    'SELECT enabled, visible_codes, version, updated_by_user_id FROM client_screen_settings')).rows;
  const audits = async () => (await q<{ event: string; user_id: string | null; request_id: string; source: string; entity_type: string; entity_id: string;
    before_json: any; after_json: any; diff_json: any; metadata_json: any }>('SELECT * FROM audit_log ORDER BY created_at')).rows;
  const update = (over: Partial<{ enabled: boolean; visibleCodes: ClientScreenCode[]; expectedVersion: number; currentUser: CurrentUser; requestId: string }>) =>
    service.updateSettings({ currentUser: admin, requestId: 'req-it', enabled: false, visibleCodes: [...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES], expectedVersion: 1, ...over });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`CREATE TABLE users(user_id bigint PRIMARY KEY, username citext, is_active boolean NOT NULL DEFAULT true, is_service_account boolean NOT NULL DEFAULT false);
      INSERT INTO users(user_id, username) VALUES (11, 'screen-admin'), (12, 'screen-manager');
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,
        user_id bigint REFERENCES users(user_id) ON DELETE SET NULL,
        username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
        related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
        stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));`);
    await q(await migration());
    migrated = (await q('SELECT config_id, enabled, visible_codes, version, updated_by_user_id FROM client_screen_settings')).rows;
    const database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          try {
            const value = await handler({ query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => connection.query<R>(text, [...params]) });
            await connection.query('COMMIT');
            return value;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          }
        } finally {
          connection.release();
        }
      },
    } as unknown as DatabaseService;
    repository = new ClientScreenRepository(database);
    service = new ClientScreenService(repository, new PermissionsService(), database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q('TRUNCATE audit_log, audit_log_related_entity');
    await q(`UPDATE client_screen_settings SET enabled = false, visible_codes = $1::text[], version = 1, updated_by_user_id = NULL`, [[...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES]]);
  });

  it('the migration creates one row: switched off, default codes, version 1', async () => {
    expect(migrated).toEqual([{ config_id: 1, enabled: false, visible_codes: [...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES], version: '1', updated_by_user_id: null }]);
    await expect(service.getSettings(manager)).resolves.toMatchObject({ enabled: false, visibleCodes: CLIENT_SCREEN_DEFAULT_VISIBLE_CODES, version: 1 });
  });

  it('re-running the migration keeps configured settings', async () => {
    await update({ enabled: true, visibleCodes: ['summary.number'] });
    await q(await migration());
    expect(await row()).toEqual([{ enabled: true, visible_codes: ['summary.number'], version: '2', updated_by_user_id: '11' }]);
  });

  it('the table refuses a second row, NULL codes and a non-positive version', async () => {
    await expect(q('INSERT INTO client_screen_settings(config_id) VALUES (2)')).rejects.toThrow(/chk_client_screen_settings_singleton/);
    await expect(q(`UPDATE client_screen_settings SET visible_codes = ARRAY['tab.basic', NULL]::text[]`)).rejects.toThrow(/chk_client_screen_settings_codes/);
    await expect(q('UPDATE client_screen_settings SET version = 0')).rejects.toThrow(/chk_client_screen_settings_version/);
  });

  it('an update is stored with its audit row: actor, request id, source, before, after, diff', async () => {
    const result = await update({ enabled: true, visibleCodes: ['details.name', 'tab.details'], requestId: 'req-audit' });
    expect(result).toMatchObject({ changed: true, settings: { enabled: true, visibleCodes: ['tab.details', 'details.name'], version: 2 } });
    expect(await row()).toEqual([{ enabled: true, visible_codes: ['tab.details', 'details.name'], version: '2', updated_by_user_id: '11' }]);
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      event: 'client_screen.settings_updated', user_id: '11', request_id: 'req-audit', source: 'backend-client-screen',
      entity_type: 'client_screen_settings', entity_id: '1',
      before_json: { enabled: false, visibleCodes: [...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES], version: 1 },
      after_json: { enabled: true, visibleCodes: ['tab.details', 'details.name'], version: 2 },
    });
    expect(Object.keys(log[0].diff_json).sort()).toEqual(['enabled', 'visibleCodes']);
    expect(log[0].metadata_json).toMatchObject({ correlationId: 'req-audit' });
  });

  it('the same values change nothing and leave no audit row', async () => {
    await expect(update({})).resolves.toMatchObject({ changed: false, settings: { version: 1 } });
    expect((await row())[0].version).toBe('1');
    expect(await audits()).toHaveLength(0);
  });

  it('a denied update is audited and changes nothing', async () => {
    expect(await code(update({ currentUser: manager, enabled: true, requestId: 'req-denied' }))).toBe('PERMISSION_DENIED');
    expect((await row())[0]).toMatchObject({ enabled: false, version: '1' });
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ event: 'client_screen.settings_denied', user_id: '12', request_id: 'req-denied', source: 'backend-client-screen', entity_type: 'client_screen_settings' });
  });

  it('when the audit write fails the settings update is rolled back', async () => {
    // The failure is injected into the audit table of the test schema; the table stays in place, so the
    // unqualified INSERT of the audit writer can never fall through to another schema.
    await q(`CREATE FUNCTION "${schema}".fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'client screen test: audit write refused'; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER trg_fail_audit BEFORE INSERT ON "${schema}".audit_log FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_audit()`);
    try {
      await expect(update({ enabled: true })).rejects.toThrow(/client screen test: audit write refused/);
    } finally {
      await q(`DROP TRIGGER trg_fail_audit ON "${schema}".audit_log`);
      await q(`DROP FUNCTION "${schema}".fail_audit()`);
    }
    expect(await row()).toEqual([{ enabled: false, visible_codes: [...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES], version: '1', updated_by_user_id: null }]);
    expect(await audits()).toHaveLength(0);
    // The audit table works again after the trigger is gone.
    await expect(update({ enabled: true })).resolves.toMatchObject({ changed: true });
    expect(await audits()).toHaveLength(1);
  });

  it('two conflicting writers with the same version: one wins, the other gets 409, the version grows once', async () => {
    const outcomes = await Promise.all([
      code(update({ enabled: true, visibleCodes: ['summary.number'], requestId: 'req-a' })),
      code(update({ enabled: true, visibleCodes: ['summary.client'], requestId: 'req-b' })),
    ]);
    expect(outcomes.sort()).toEqual(['CLIENT_SCREEN_SETTINGS_VERSION_CONFLICT', 'ok']);
    const [stored] = await row();
    expect(stored.version).toBe('2');
    expect([['summary.number'], ['summary.client']]).toContainEqual(stored.visible_codes);
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].after_json.visibleCodes).toEqual(stored.visible_codes);
  });

  it('an inactive or service account cannot change the settings', async () => {
    await q('UPDATE users SET is_active = false WHERE user_id = 11');
    try {
      expect(await code(update({ enabled: true }))).toBe('CLIENT_SCREEN_ACTOR_INVALID');
    } finally {
      await q('UPDATE users SET is_active = true WHERE user_id = 11');
    }
    expect((await row())[0].version).toBe('1');
  });
});
