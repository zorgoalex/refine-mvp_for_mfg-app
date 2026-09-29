import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { DailyDigestSnapshot } from '../daily-digest-snapshot.types';
import { BroadcastRepository, commandFingerprint, type PreparationContext } from './broadcast.repository';
import type { BroadcastInput, BroadcastStoredImage } from './broadcast.types';

// Real PostgreSQL in an isolated schema: set WHATSAPP_BROADCAST_TEST_DATABASE_URL (or TEST_DATABASE_URL).
const databaseUrl = process.env.WHATSAPP_BROADCAST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const GROUP = '120363338054016575@g.us';
const OTHER_GROUP = '120363429893275855@g.us';
const admin: CurrentUser = { id: '11', username: 'broadcast-admin', role: 'admin', roleId: 1, permissions: [] };
const other: CurrentUser = { id: '12', username: 'broadcast-other', role: 'admin', roleId: 1, permissions: [] };
const hour = 60 * 60_000;
const at = (date: string, clock: string) => new Date(`${date}T${clock}+05:00`);
// 2026-10-05 is a Monday, 2026-10-06 a Tuesday.
const MONDAY = '2026-10-05';

function input(overrides: Partial<BroadcastInput> = {}): BroadcastInput {
  return {
    name: `Тест ${randomUUID().slice(0, 8)}`, enabled: true, groupChatId: GROUP, weekdays: [1, 2, 3, 4, 5], sendTime: '08:45',
    sendWindowMinutes: 0, catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00', partialPolicy: 'remaining', orderDateOffsetDays: 1,
    cardsPerMessage: 2, captionTemplate: 'Заказы на {target_date}', duplicateRiskConfirmed: false, ...overrides,
  };
}
const snapshotFor = (date: string, orderIds: number[]): DailyDigestSnapshot => ({
  businessDate: date, rendererVersion: 'test-v3', cardsPerMessage: 2, totalArea: 3.5,
  orders: orderIds.map((orderId) => ({ orderId, orderName: String(orderId), orderDate: date, plannedCompletionDate: date, clientName: 'Клиент',
    orderStatusName: 'В работе', paymentStatusName: 'Оплачен', totalArea: 1.75, basisProjectDisplay: null, materials: [], millingDisplay: '—',
    passedProductionCodes: [] })),
  workflowDisplay: { displayOrderCodes: [], codeToLetter: {}, codeToName: {} },
});
// Business logic runs on fixed dates in October 2026, so stored images must outlive them.
const FAR_FUTURE = new Date('2027-06-01T00:00:00Z');
const image = (index: number, orderIds: number[], expiresAt = FAR_FUTURE): BroadcastStoredImage => ({
  imageIndex: index, orderIds, fileKey: `${randomUUID()}-${index}.png`, sha256: 'b'.repeat(64), sizeBytes: 100, expiresAt, caption: index === 1 ? 'Подпись' : null,
});

describe.skipIf(!databaseUrl)('BroadcastRepository PostgreSQL (isolated schema)', () => {
  const schema = `e2e_broadcast_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let repository: BroadcastRepository;
  let database: DatabaseService;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);

  beforeAll(async () => {
    // Independent connections: every transaction gets its own client, so races are real.
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q(`CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
      username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
      related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
      stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE roles(role_id int PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text, role_id int REFERENCES roles, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE role_permissions(role_id int, permission_name text, is_enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(role_id, permission_name));
      INSERT INTO roles VALUES (1, true), (2, true);
      INSERT INTO users VALUES (11, 'broadcast-admin', 1, true), (12, 'broadcast-other', 2, true);
      INSERT INTO permissions_catalog(permission_name) VALUES ('whatsapp.manage'),('calendar.view'),('orders.view'),('orders.view_financials');
      INSERT INTO role_permissions(role_id, permission_name) SELECT r, p FROM (VALUES (1),(2)) roles(r), permissions_catalog pc(p);`);
    for (const file of ['183_whatsapp_daily_digest.sql', '184_whatsapp_daily_digest_schedule.sql', '209_whatsapp_broadcasts.sql']) {
      await q(await readFile(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    database = {
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
      transaction: async <T>(handler: (tx: { query: <R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) => Promise<unknown> }) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          try {
            const value = await handler({ query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => connection.query<R>(text, [...params]) as Promise<unknown> });
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
    repository = new BroadcastRepository(database);
  }, 30_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q('UPDATE whatsapp_broadcast_control SET paused = false');
    await q('UPDATE users SET is_active = true');
    await q('UPDATE whatsapp_broadcasts SET enabled = false');
  });

  const create = async (overrides: Partial<BroadcastInput> = {}) => repository.createBroadcast(input(overrides), admin, `req-${randomUUID()}`);
  const fix = (id: number, now: Date) => repository.fixAutomaticRun(id, () => now, () => 0);
  const autoRunOf = async (id: number, date: string) => (await q<{ run_id: string; state: string; reason: string | null }>(
    `SELECT run_id, state, reason FROM whatsapp_broadcast_runs WHERE broadcast_id = $1 AND business_date = $2 AND kind = 'auto' AND superseded_at IS NULL`, [id, date])).rows[0];
  const prepare = async (id: number, date: string, now: Date, orderIds = [1, 2, 3]) => {
    const run = await autoRunOf(id, date);
    const context = await repository.getPreparationContext(run.run_id) as PreparationContext;
    return { context, outcome: await repository.completePreparation(context, { snapshot: snapshotFor(context.targetDate, orderIds), images: [image(1, [1, 2]), image(2, [3])], imageExpiresAt: FAR_FUTURE, clock: () => now }) };
  };

  it('migration 209 created broadcast #1 from the disabled digest singleton and audited the cutover', async () => {
    const first = await repository.getBroadcast(1);
    expect(first).toMatchObject({ id: 1, name: 'Рассылка заказов', weekdays: [1, 2, 3, 4, 5, 6, 7], captionTemplate: 'Заказы на сегодня', orderDateOffsetDays: 0 });
    const singleton = (await q<{ enabled: boolean; version: number }>('SELECT enabled, version FROM whatsapp_daily_digest_settings')).rows[0];
    expect(singleton).toEqual({ enabled: false, version: 2 });
    expect((await q(`SELECT 1 FROM audit_log WHERE event = 'whatsapp.daily_digest.settings.disabled_by_cutover'`)).rowCount).toBe(1);
  });

  it('versions settings, keeps names unique among active broadcasts and audits a masked destination', async () => {
    const broadcast = await create({ name: 'Уникальная' });
    await expect(create({ name: 'уникальная' })).rejects.toMatchObject({ code: 'BROADCAST_NAME_TAKEN' });
    const updated = await repository.updateBroadcast(broadcast.id, { ...input({ name: 'Уникальная', groupChatId: OTHER_GROUP }), version: broadcast.version }, admin, 'req-update');
    expect(updated.version).toBe(broadcast.version + 1);
    await expect(repository.updateBroadcast(broadcast.id, { ...input({ name: 'Уникальная' }), version: broadcast.version }, admin, 'req-stale'))
      .rejects.toMatchObject({ code: 'BROADCAST_VERSION_CONFLICT' });
    const audit = (await q<{ before_json: Record<string, unknown>; after_json: Record<string, unknown>; diff_json: Record<string, unknown>; metadata_json: Record<string, unknown> }>(
      `SELECT before_json, after_json, diff_json, metadata_json FROM audit_log WHERE event = 'whatsapp.broadcast.updated' AND entity_id = $1`, [String(broadcast.id)])).rows[0];
    // Settings changes live in the standard before/after/diff columns, not only in metadata.
    expect(audit.before_json).toEqual(expect.objectContaining({ name: 'Уникальная' }));
    expect(Object.keys(audit.diff_json)).toEqual(['groupFingerprint']);
    expect(audit.metadata_json).toEqual({ version: updated.version });
    expect(JSON.stringify(audit)).not.toContain('429893275855');
    expect(JSON.stringify(audit)).not.toContain('{target_date}');
  });

  it('fixes exactly one automatic slot per day, only on selected weekdays, and records a missed window', async () => {
    const broadcast = await create({ weekdays: [1] });
    expect(await fix(broadcast.id, at('2026-10-06', '09:00:00'))).toBe('not_today');
    expect(await fix(broadcast.id, at(MONDAY, '08:44:50'))).toBe('before');
    expect(await fix(broadcast.id, at(MONDAY, '08:45:10'))).toBe('fixed');
    expect(await fix(broadcast.id, at(MONDAY, '08:45:25'))).toBe('exists');
    expect((await autoRunOf(broadcast.id, MONDAY)).state).toBe('preparing');
    const late = await create({ weekdays: [1], catchUpPolicy: 'skip' });
    expect(await fix(late.id, at(MONDAY, '08:47:00'))).toBe('skipped');
    expect(await autoRunOf(late.id, MONDAY)).toMatchObject({ state: 'skipped', reason: 'MISSED_WINDOW' });
  });

  it('blocks fixation, commands and send intents while paused', async () => {
    const broadcast = await create();
    await q('UPDATE whatsapp_broadcast_control SET paused = true');
    expect(await fix(broadcast.id, at(MONDAY, '08:46:00'))).toBe('paused');
    await expect(repository.createManualRun({ broadcastId: broadcast.id, settingsVersion: broadcast.version, idempotencyKey: randomUUID(),
      fingerprint: 'c'.repeat(64), actor: admin, requestId: 'req-paused', businessDate: MONDAY, targetDate: '2026-10-06',
      snapshot: snapshotFor('2026-10-06', [1]), images: [image(1, [1])], imageExpiresAt: new Date(Date.now() + hour) })).rejects.toMatchObject({ code: 'BROADCASTS_PAUSED' });
  });

  it('uses the legacy digest run as the slot of broadcast #1 on the cutover day', async () => {
    await q(`UPDATE whatsapp_broadcasts SET enabled = true, group_chat_id = $1 WHERE broadcast_id = 1`, [GROUP]);
    await q(`INSERT INTO whatsapp_daily_digest_runs(run_id,business_date,kind,idempotency_key,request_digest,settings_version,destination_chat_id,catch_up_policy,
      partial_policy,renderer_version,order_count,total_area,state) VALUES (gen_random_uuid(),$1,'auto',gen_random_uuid(),repeat('a',64),1,$2,'until_deadline','remaining','v1',0,0,'sent')`, [MONDAY, GROUP]);
    expect(await fix(1, at(MONDAY, '09:00:00'))).toBe('exists');
  });

  it('prepares only current work: another generation or changed settings supersede it, a revoked author fails it', async () => {
    const date = '2026-10-07';
    const replanned = await create();
    await fix(replanned.id, at(date, '08:45:05'));
    const staleContext = await repository.getPreparationContext((await autoRunOf(replanned.id, date)).run_id) as PreparationContext;
    await q('UPDATE whatsapp_broadcasts SET schedule_generation = schedule_generation + 1 WHERE broadcast_id = $1', [replanned.id]);
    expect(await repository.completePreparation(staleContext, { snapshot: snapshotFor(staleContext.targetDate, [1]), images: [image(1, [1])], imageExpiresAt: new Date(Date.now() + hour), clock: () => at(date, '08:46:00') })).toBe('superseded');

    const edited = await create();
    await fix(edited.id, at(date, '08:45:05'));
    const editedContext = await repository.getPreparationContext((await autoRunOf(edited.id, date)).run_id) as PreparationContext;
    await repository.updateBroadcast(edited.id, { ...input({ name: (await repository.getBroadcast(edited.id)).name, cardsPerMessage: 1 }), version: edited.version }, admin, 'req-edit');
    expect(await repository.completePreparation(editedContext, { snapshot: snapshotFor(editedContext.targetDate, [1]), images: [image(1, [1])], imageExpiresAt: new Date(Date.now() + hour), clock: () => at(date, '08:46:00') })).toBe('superseded');
    expect(await fix(edited.id, at(date, '08:46:10'))).toBe('fixed');

    const revoked = await create();
    await fix(revoked.id, at(date, '08:45:05'));
    await q('UPDATE users SET is_active = false WHERE user_id = 11');
    expect((await prepare(revoked.id, date, at(date, '08:46:00'))).outcome).toBe('revoked');
    const revokedRun = (await autoRunOf(revoked.id, date)).run_id;
    const revokedAudit = (await q<{ request_id: string; status_code: string; metadata_json: Record<string, unknown> }>(
      `SELECT request_id, status_code, metadata_json FROM audit_log WHERE event = 'whatsapp.broadcast.run.permission_revoked' AND entity_id = $1`, [revokedRun])).rows;
    expect(revokedAudit).toEqual([expect.objectContaining({ request_id: `broadcast-auto-${revokedRun}`, status_code: 'failed', metadata_json: expect.objectContaining({ stage: 'preparation' }) })]);
  });

  it('delivers in strict order, refuses intents after author revocation and after disabling, per broadcast only', async () => {
    const date = '2026-10-08';
    const a = await create();
    const b = await create();
    const c = await create();
    await fix(a.id, at(date, '08:45:05'));
    await fix(b.id, at(date, '08:45:05'));
    await fix(c.id, at(date, '08:45:05'));
    expect((await prepare(a.id, date, at(date, '08:46:00'))).outcome).toBe('queued');
    expect((await prepare(b.id, date, at(date, '08:46:00'))).outcome).toBe('queued');
    expect((await prepare(c.id, date, at(date, '08:46:00'))).outcome).toBe('queued');
    const runA = (await autoRunOf(a.id, date)).run_id;
    const runB = (await autoRunOf(b.id, date)).run_id;
    const runC = (await autoRunOf(c.id, date)).run_id;
    const now = at(date, '08:47:00');
    const grantC = await repository.createSendIntent(runC, 1, true, () => now);
    expect(await repository.settleMessage(runC, 1, grantC!.token, { state: 'sent', providerMessageId: 'wamid-c1' })).toBe(true);
    expect(await repository.createSendIntent(runA, 2, true, () => now)).toBeNull();
    const grant = await repository.createSendIntent(runA, 1, true, () => now);
    expect(grant).toMatchObject({ destinationChatId: GROUP, kind: 'image', caption: 'Подпись' });
    expect(await repository.settleMessage(runA, 1, grant!.token, { state: 'sent', providerMessageId: 'wamid-1' })).toBe(true);
    await repository.updateBroadcast(a.id, { ...input({ name: (await repository.getBroadcast(a.id)).name, enabled: false }), version: (await repository.getBroadcast(a.id)).version }, admin, 'req-disable');
    expect((await q('SELECT state, reason FROM whatsapp_broadcast_runs WHERE run_id = $1', [runA])).rows[0]).toEqual({ state: 'partial', reason: 'DISABLED_PARTIAL' });
    expect((await q(`SELECT count(*)::int n FROM whatsapp_broadcast_messages WHERE run_id = $1 AND state = 'pending'`, [runB])).rows[0].n).toBe(2);
    await q('UPDATE users SET is_active = false WHERE user_id = 11');
    expect(await repository.createSendIntent(runB, 1, true, () => now)).toBeNull();
    expect((await q('SELECT state, reason FROM whatsapp_broadcast_runs WHERE run_id = $1', [runB])).rows[0]).toEqual({ state: 'failed', reason: 'BROADCAST_AUTHOR_PERMISSION_REVOKED' });
    // After a partial delivery the run becomes `partial`, and the audit records that state.
    expect(await repository.createSendIntent(runC, 2, true, () => now)).toBeNull();
    expect((await q('SELECT state FROM whatsapp_broadcast_runs WHERE run_id = $1', [runC])).rows[0].state).toBe('partial');
    const revokedAudit = async (runId: string) => (await q<{ status_code: string }>(
      `SELECT status_code FROM audit_log WHERE event = 'whatsapp.broadcast.run.permission_revoked' AND entity_id = $1`, [runId])).rows.map((row) => row.status_code);
    expect(await revokedAudit(runB)).toEqual(['failed']);
    expect(await revokedAudit(runC)).toEqual(['partial']);
  });

  it('replays manual commands from the ledger and rejects a reused key with another payload', async () => {
    const broadcast = await create({ enabled: false });
    const key = randomUUID();
    const base = { broadcastId: broadcast.id, settingsVersion: broadcast.version, idempotencyKey: key, actor: admin, requestId: 'req-manual',
      businessDate: MONDAY, targetDate: '2026-10-06', snapshot: snapshotFor('2026-10-06', [5]), images: [image(1, [5])], imageExpiresAt: new Date(Date.now() + hour) };
    const fingerprint = commandFingerprint({ kind: 'manual', broadcastId: broadcast.id, settingsVersion: broadcast.version, actorId: admin.id, confirmed: true });
    const first = await repository.createManualRun({ ...base, fingerprint });
    const again = await repository.createManualRun({ ...base, fingerprint, images: [image(1, [5])] });
    expect(again).toEqual({ runId: first.runId, replayed: true });
    await expect(repository.createManualRun({ ...base, fingerprint: commandFingerprint({ other: true }) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(repository.replanToday({ broadcastId: broadcast.id, version: broadcast.version, idempotencyKey: key, fingerprint: commandFingerprint({ kind: 'replan' }),
      actor: admin, requestId: 'req-replan-reuse', now: at(MONDAY, '09:00:00') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await q('SELECT count(*)::int n FROM whatsapp_broadcast_runs WHERE broadcast_id = $1', [broadcast.id])).rows[0].n).toBe(1);
  });

  it('replans today only before sending, supersedes the chain, replays the ledger and forbids retrying the old chain', async () => {
    const date = '2026-10-09';
    const broadcast = await create();
    await fix(broadcast.id, at(date, '08:45:05'));
    await prepare(broadcast.id, date, at(date, '08:46:00'));
    const oldRun = (await autoRunOf(broadcast.id, date)).run_id;
    const key = randomUUID();
    const fingerprint = commandFingerprint({ kind: 'replan', broadcastId: broadcast.id, version: broadcast.version, actorId: admin.id });
    const replan = () => repository.replanToday({ broadcastId: broadcast.id, version: broadcast.version, idempotencyKey: key, fingerprint, actor: admin,
      requestId: 'req-replan', now: at(date, '08:50:00') });
    expect(await replan()).toEqual({ generation: 2, replayed: false });
    expect(await replan()).toEqual({ generation: 2, replayed: true });
    expect((await q('SELECT schedule_generation FROM whatsapp_broadcasts WHERE broadcast_id = $1', [broadcast.id])).rows[0].schedule_generation).toBe(2);
    expect((await q('SELECT state, superseded_at IS NOT NULL superseded FROM whatsapp_broadcast_runs WHERE run_id = $1', [oldRun])).rows[0]).toEqual({ state: 'cancelled', superseded: true });
    expect(await repository.createSendIntent(oldRun, 1, true, () => at(date, '08:51:00'))).toBeNull();
    await expect(repository.createRetry(oldRun, { mode: 'all', idempotencyKey: randomUUID(), duplicateRiskConfirmed: true, actor: admin, requestId: 'req-retry-old',
      fingerprintFor: (id) => commandFingerprint({ id, retry: true }) })).rejects.toMatchObject({ code: 'BROADCAST_RUN_SUPERSEDED' });
    // The new generation fixes a fresh slot for the same day.
    expect(await fix(broadcast.id, at(date, '08:51:00'))).toBe('fixed');

    await prepare(broadcast.id, date, at(date, '08:52:00'));
    const fresh = (await autoRunOf(broadcast.id, date)).run_id;
    const grant = await repository.createSendIntent(fresh, 1, true, () => at(date, '08:53:00'));
    expect(grant).not.toBeNull();
    const current = await repository.getBroadcast(broadcast.id);
    await expect(repository.replanToday({ broadcastId: broadcast.id, version: current.version, idempotencyKey: randomUUID(),
      fingerprint: commandFingerprint({ second: true }), actor: admin, requestId: 'req-replan-2', now: at(date, '08:54:00') }))
      .rejects.toMatchObject({ code: 'BROADCAST_TODAY_ALREADY_SENDING' });
  });

  it('retries inherit the original author: revoking that author stops the retry started by someone else', async () => {
    const broadcast = await create({ enabled: false });
    const manual = await repository.createManualRun({ broadcastId: broadcast.id, settingsVersion: broadcast.version, idempotencyKey: randomUUID(),
      fingerprint: 'd'.repeat(64), actor: admin, requestId: 'req-m', businessDate: MONDAY, targetDate: '2026-10-06', snapshot: snapshotFor('2026-10-06', [7]),
      images: [image(1, [7])], imageExpiresAt: new Date(Date.now() + hour) });
    const grant = await repository.createSendIntent(manual.runId, 1, true);
    await repository.settleMessage(manual.runId, 1, grant!.token, { state: 'failed', errorCode: 'WAHA_PROVIDER_ERROR' });
    const retry = await repository.createRetry(manual.runId, { mode: 'remaining', idempotencyKey: randomUUID(), duplicateRiskConfirmed: false, actor: other,
      requestId: 'req-r', fingerprintFor: (id) => commandFingerprint({ kind: 'retry', id }) });
    const row = (await q('SELECT snapshot_author_user_id::text author, initiated_by_user_id::text initiator FROM whatsapp_broadcast_runs WHERE run_id = $1', [retry.runId])).rows[0];
    expect(row).toEqual({ author: '11', initiator: '12' });
    await q('UPDATE users SET is_active = false WHERE user_id = 11');
    expect(await repository.createSendIntent(retry.runId, 1, true)).toBeNull();
    expect((await q('SELECT reason FROM whatsapp_broadcast_runs WHERE run_id = $1', [retry.runId])).rows[0].reason).toBe('BROADCAST_AUTHOR_PERMISSION_REVOKED');
  });

  it('answers an active retry in the chain with the temporary RETRY_ACTIVE, so a delayed same-key retry is replayed, not duplicated', async () => {
    const broadcast = await create({ enabled: false });
    const manual = await repository.createManualRun({ broadcastId: broadcast.id, settingsVersion: broadcast.version, idempotencyKey: randomUUID(),
      fingerprint: 'c'.repeat(64), actor: admin, requestId: 'req-m2', businessDate: MONDAY, targetDate: '2026-10-06', snapshot: snapshotFor('2026-10-06', [6]),
      images: [image(1, [6])], imageExpiresAt: FAR_FUTURE });
    const first = await repository.createSendIntent(manual.runId, 1, true);
    await repository.settleMessage(manual.runId, 1, first!.token, { state: 'failed', errorCode: 'WAHA_PROVIDER_ERROR' });
    const retryInput = (key: string) => ({ mode: 'remaining' as const, idempotencyKey: key, duplicateRiskConfirmed: false, actor: admin,
      requestId: `req-${key}`, fingerprintFor: (id: number) => commandFingerprint({ kind: 'retry', id, key: 'same-payload' }) });
    // Someone else's retry is active in the chain.
    const active = await repository.createRetry(manual.runId, retryInput(randomUUID()));
    // The restored attempt of key K arrives first and is refused temporarily (the client keeps K).
    const key = randomUUID();
    await expect(repository.createRetry(manual.runId, retryInput(key))).rejects.toMatchObject({ code: 'BROADCAST_RETRY_ACTIVE' });
    // The active retry finishes; the delayed first attempt of K now creates the retry …
    const grant = await repository.createSendIntent(active.runId, 1, true);
    await repository.settleMessage(active.runId, 1, grant!.token, { state: 'failed', errorCode: 'WAHA_PROVIDER_ERROR' });
    const delayed = await repository.createRetry(manual.runId, retryInput(key));
    expect(delayed.replayed).toBe(false);
    // … and the client's next attempt with the kept K is a replay, not a second retry.
    const again = await repository.createRetry(manual.runId, retryInput(key));
    expect(again).toEqual({ runId: delayed.runId, replayed: true });
    expect((await q(`SELECT count(*)::int n FROM whatsapp_broadcast_runs WHERE root_run_id = $1 AND kind = 'retry'`, [manual.runId])).rows[0].n).toBe(2);
  });

  it('holds the 20-enabled cap under concurrent enabling from independent connections', async () => {
    for (let index = 0; index < 19; index += 1) await create();
    const [first, second] = [await create({ enabled: false }), await create({ enabled: false })];
    const enable = (broadcast: Awaited<ReturnType<typeof create>>) => repository.updateBroadcast(broadcast.id,
      { ...input({ name: broadcast.name, enabled: true }), version: broadcast.version }, admin, `req-${randomUUID()}`);
    const results = await Promise.allSettled([enable(first), enable(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'BROADCAST_ACTIVE_LIMIT' } });
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM whatsapp_broadcasts WHERE enabled AND archived_at IS NULL')).rows[0].n).toBe(20);
  });

  it('fixes all 20 broadcasts due in the same minute in one fixation pass', async () => {
    const date = '2026-10-12';
    const ids: number[] = [];
    for (let index = 0; index < 20; index += 1) ids.push((await create({ catchUpPolicy: 'skip' })).id);
    const outcomes = [];
    for (const id of await repository.listActiveBroadcastIds()) outcomes.push(await fix(id, at(date, '08:45:30')));
    expect(outcomes).toHaveLength(20);
    expect(outcomes.every((outcome) => outcome === 'fixed')).toBe(true);
  });

  it('replays one manual command when the same key races from two connections', async () => {
    const broadcast = await create({ enabled: false });
    const key = randomUUID();
    const fingerprint = commandFingerprint({ kind: 'manual', broadcastId: broadcast.id, settingsVersion: broadcast.version, actorId: admin.id, confirmed: true });
    const send = () => repository.createManualRun({ broadcastId: broadcast.id, settingsVersion: broadcast.version, idempotencyKey: key, fingerprint, actor: admin,
      requestId: 'req-race', businessDate: MONDAY, targetDate: '2026-10-06', snapshot: snapshotFor('2026-10-06', [9]), images: [image(1, [9])], imageExpiresAt: FAR_FUTURE });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.runId).toBe(b.runId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM whatsapp_broadcast_runs WHERE broadcast_id = $1', [broadcast.id])).rows[0].n).toBe(1);
  });

  it('never sends past the deadline even if the iteration started before it', async () => {
    const date = '2026-10-13';
    const broadcast = await create();
    await fix(broadcast.id, at(date, '08:45:05'));
    await prepare(broadcast.id, date, at(date, '08:46:00'));
    const run = (await autoRunOf(broadcast.id, date)).run_id;
    expect(await repository.createSendIntent(run, 1, true, () => at(date, '10:02:00'))).toBeNull();
    expect((await q('SELECT state FROM whatsapp_broadcast_messages WHERE run_id = $1 AND delivery_seq = 1', [run])).rows[0].state).toBe('expired');
  });

  it('treats the rollback purge as terminal for preparation and delivery', async () => {
    const date = '2026-10-14';
    const preparing = await create();
    const queued = await create();
    await fix(preparing.id, at(date, '08:45:05'));
    await fix(queued.id, at(date, '08:45:05'));
    await prepare(queued.id, date, at(date, '08:46:00'));
    const context = await repository.getPreparationContext((await autoRunOf(preparing.id, date)).run_id) as PreparationContext;
    const queuedRun = (await autoRunOf(queued.id, date)).run_id;
    // Runbook step 4, executed while the render is in flight.
    await q(`UPDATE whatsapp_broadcast_messages SET state = 'cancelled', error_code = 'CONTENT_PURGED', updated_at = now() WHERE state = 'pending'`);
    await q(`UPDATE whatsapp_broadcast_runs SET state = 'cancelled', reason = 'CONTENT_PURGED', updated_at = now() WHERE state IN ('preparing','queued','sending')`);
    await q('UPDATE whatsapp_broadcast_runs SET snapshot = NULL, content_purged_at = now() WHERE content_purged_at IS NULL');
    expect(await repository.completePreparation(context, { snapshot: snapshotFor(context.targetDate, [1]), images: [image(1, [1])], imageExpiresAt: FAR_FUTURE, clock: () => at(date, '08:47:00') })).toBe('stale');
    expect((await q('SELECT snapshot IS NULL AS purged FROM whatsapp_broadcast_runs WHERE run_id = $1', [context.runId])).rows[0].purged).toBe(true);
    expect(await repository.listPreparingRuns(10)).not.toContain(context.runId);
    expect(await repository.listDeliverableRuns()).not.toContain(queuedRun);
    expect(await repository.createSendIntent(queuedRun, 1, true, () => at(date, '08:48:00'))).toBeNull();
  });

  it('keeps unexpired images of cancelled messages referenced so a retry can still send them', async () => {
    const date = '2026-10-15';
    const broadcast = await create();
    await fix(broadcast.id, at(date, '08:45:05'));
    await prepare(broadcast.id, date, at(date, '08:46:00'));
    const run = (await autoRunOf(broadcast.id, date)).run_id;
    await repository.updateBroadcast(broadcast.id, { ...input({ name: broadcast.name, enabled: false }), version: broadcast.version }, admin, 'req-off');
    const keys = (await q<{ file_key: string }>(`SELECT file_key FROM whatsapp_broadcast_messages WHERE run_id = $1 AND state = 'cancelled'`, [run])).rows.map((row) => row.file_key);
    expect(keys).toHaveLength(2);
    const refs = await repository.expireAndPrune(new Date());
    for (const key of keys) expect(refs.referenced.has(key)).toBe(true);
  });

  it('carries the command request id and the automatic correlation id into delivery audit events', async () => {
    const broadcast = await create({ enabled: false });
    const manual = await repository.createManualRun({ broadcastId: broadcast.id, settingsVersion: broadcast.version, idempotencyKey: randomUUID(),
      fingerprint: 'e'.repeat(64), actor: admin, requestId: 'req-correlate', businessDate: MONDAY, targetDate: '2026-10-06',
      snapshot: snapshotFor('2026-10-06', [8]), images: [image(1, [8])], imageExpiresAt: FAR_FUTURE });
    const grant = await repository.createSendIntent(manual.runId, 1, true);
    await repository.settleMessage(manual.runId, 1, grant!.token, { state: 'sent', providerMessageId: 'wamid-c' });
    const events = (await q<{ event: string; request_id: string }>(`SELECT event, request_id FROM audit_log WHERE entity_id = $1 ORDER BY created_at`, [manual.runId])).rows;
    expect(events.map((row) => row.event)).toEqual(['whatsapp.broadcast.run.manual', 'whatsapp.broadcast.message.intent', 'whatsapp.broadcast.message.sent']);
    expect(new Set(events.map((row) => row.request_id))).toEqual(new Set(['req-correlate']));

    const date = '2026-10-16';
    const auto = await create();
    await fix(auto.id, at(date, '08:45:05'));
    await prepare(auto.id, date, at(date, '08:46:00'));
    const autoRun = (await autoRunOf(auto.id, date)).run_id;
    await repository.createSendIntent(autoRun, 1, true, () => at(date, '08:47:00'));
    const autoIds = (await q<{ request_id: string }>(`SELECT DISTINCT request_id FROM audit_log WHERE entity_id = $1`, [autoRun])).rows.map((row) => row.request_id);
    expect(autoIds).toEqual([`broadcast-auto-${autoRun}`]);
  });

  it('runs the production digest SQL (e2975dca repository) unchanged on the migrated database', async () => {
    const { DailyDigestRepository } = await import('../daily-digest.repository');
    const legacy = new DailyDigestRepository(database);
    const settings = await legacy.getSettings();
    expect(settings.enabled).toBe(false);
    expect(await legacy.getOrCreateSchedule('2026-10-20', () => 0)).toBeNull();
    const runId = randomUUID();
    await legacy.createRun({ runId, businessDate: '2026-10-20', kind: 'manual', idempotencyKey: randomUUID(), settingsVersion: settings.version,
      destinationChatId: GROUP, catchUpPolicy: 'until_deadline', deadlineAt: FAR_FUTURE, partialPolicy: 'remaining', snapshot: snapshotFor('2026-10-20', [4]),
      orderCount: 1, totalArea: 1.75, state: 'queued', actor: admin, requestId: 'req-legacy', imageExpiresAt: FAR_FUTURE },
    [{ pageIndex: 1, orderIds: [4], fileKey: `${randomUUID()}-1.png`, sha256: 'f'.repeat(64), sizeBytes: 10, expiresAt: FAR_FUTURE }]);
    const intent = await legacy.createSendIntent(runId, 1, true);
    expect(intent).not.toBeNull();
    expect(await legacy.settlePage(runId, 1, intent!.token, { state: 'sent', providerMessageId: 'legacy-1' })).toBe(true);
    await legacy.expireImagesAndPruneSnapshots(new Date());
    const history = await legacy.listRuns();
    expect(history.runs.map((run) => run.id)).toContain(runId);
    expect((await q('SELECT count(*)::int n FROM whatsapp_broadcast_runs')).rows[0].n).toBeGreaterThan(0);
  });

  it('keeps the old digest schema byte-identical to 183/184 (only the singleton row changed)', async () => {
    const reference = `${schema}_ref`;
    const shape = async (name: string) => (await q<{ item: string }>(`
      SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '') AS item
        FROM information_schema.columns WHERE table_schema = $1 AND table_name LIKE 'whatsapp_daily_digest_%'
      UNION ALL
      SELECT rel.relname || '#' || con.conname || ':' || pg_get_constraintdef(con.oid) FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1 AND rel.relname LIKE 'whatsapp_daily_digest_%'
      UNION ALL
      SELECT tablename || '@' || indexname || ':' || replace(indexdef, $1, 'S') FROM pg_indexes WHERE schemaname = $1 AND tablename LIKE 'whatsapp_daily_digest_%'
      ORDER BY 1`, [name])).rows.map((row) => row.item.replaceAll(`"${name}".`, '').replaceAll(`${name}.`, ''));
    await q(`CREATE SCHEMA "${reference}"`);
    try {
      await q(`SET search_path="${reference}",public`);
      for (const file of ['183_whatsapp_daily_digest.sql', '184_whatsapp_daily_digest_schedule.sql']) {
        await q(await readFile(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
      }
      await q(`SET search_path="${schema}",public`);
      expect(await shape(schema)).toEqual(await shape(reference));
    } finally {
      await q(`SET search_path="${schema}",public`);
      await q(`DROP SCHEMA IF EXISTS "${reference}" CASCADE`);
    }
  });
});
