import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { ProcurementNotificationsService } from '../application/procurement-notifications.service';
import { addDays, todayInAlmaty } from '../domain/procurement-worklist';
import { PgProcurementNotificationsRepository } from './pg-procurement-notifications-repository';
import { PgProcurementWorkspaceRepository } from './pg-procurement-workspace-repository';

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/procurement-notification-recipients/run-races.cjs).
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;

const DIGEST = 'procurement-deficit-digest';
const UNALLOCATED = 'procurement-receipt-unallocated';

describe.skipIf(!url)('Procurement notification recipients + daily unallocated summary (plan 2026-10-02) — real PostgreSQL', { timeout: 90000 }, () => {
  let pool: Pool;
  let conn: PoolClient;
  let other: PoolClient;
  const tag = 'E2E-Тест-ПУ-' + randomUUID().slice(0, 8);
  let adminId: number;
  let managerId: number;
  let viewerOnlyId: number;
  let noViewId: number;
  let inactiveId: number;
  let noViewRoleId: number;
  let database: DatabaseService;
  let database2: DatabaseService;
  const startedAt = new Date();

  const makeDatabase = () => new DatabaseService(new ConfigService<BackendEnv, true>({
    DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
  } as Partial<BackendEnv>), { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
  const user = async (suffix: string, roleId: number, active = true) => Number((await conn.query(
    `INSERT INTO users (username, email, password_hash, role_id, is_active) VALUES ($1, $2, 'E2E-NO-LOGIN', $3, $4) RETURNING user_id`,
    [`${tag}-${suffix}`, `${tag}-${suffix}@example.invalid`, roleId, active])).rows[0].user_id);
  const grant = (roleId: number, permission: string, enabled: boolean) => conn.query(
    `INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES ($1, $2, $3)
     ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`, [roleId, permission, enabled]);
  const setRule = (code: string, enabled: boolean, recipients: Record<string, unknown> = {}) => conn.query(
    'UPDATE notification_rules SET is_enabled = $2, recipients_json = $3::jsonb WHERE rule_code = $1', [code, enabled, JSON.stringify(recipients)]);
  const ids = (users: Array<{ id: string }>) => users.map((u) => Number(u.id));
  /** Ждать, пока сессия с запросом, содержащим `fragment`, не встанет в ожидание блокировки (вместо сна). */
  const waitForLockWait = async (fragment: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = Number((await conn.query(
        `SELECT count(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`])).rows[0].c);
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no session is waiting on a lock for: ${fragment}`);
  };

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    conn = await pool.connect();
    other = await pool.connect();
    // Роль 10 (менеджер): view + manage; роль без procurement.view — для проверки отсечения по праву.
    await grant(10, 'procurement.view', true);
    await grant(10, 'procurement.manage', true);
    noViewRoleId = Number((await conn.query(
      `SELECT r.role_id FROM roles r WHERE r.is_active AND r.role_id NOT IN (1, 10)
         AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.role_id AND rp.permission_name = 'procurement.view' AND rp.is_enabled)
       ORDER BY r.role_id LIMIT 1`)).rows[0].role_id);
    adminId = await user('admin', 1);
    managerId = await user('manager', 10);
    viewerOnlyId = await user('viewer', 10);
    noViewId = await user('noview', noViewRoleId);
    inactiveId = await user('inactive', 10, false);
    await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
    database = makeDatabase();
    database2 = makeDatabase();
  }, 60000);

  afterAll(async () => {
    await setRule(DIGEST, false).catch(() => undefined);
    await setRule(UNALLOCATED, false).catch(() => undefined);
    await conn?.query(`DELETE FROM notifications WHERE source_type = 'procurement_digest' AND created_at >= $1`, [startedAt]).catch(() => undefined);
    await conn?.query(`DELETE FROM outbox_events WHERE event_type IN ('procurement.deficit_digest', 'procurement.receipt_unallocated') AND created_at >= $1`, [startedAt]).catch(() => undefined);
    await database?.onModuleDestroy().catch(() => undefined);
    await database2?.onModuleDestroy().catch(() => undefined);
    try { conn?.release(); } catch { /* released */ }
    try { other?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('recipients: empty → default right; roles ∪ users; always the required right, active and non-service only; reset {} → default', async () => {
    const repo = new PgProcurementNotificationsRepository(database);
    const noViewRoleCode = String((await conn.query('SELECT role_code FROM roles WHERE role_id = $1', [noViewRoleId])).rows[0].role_code);
    // Умолчание: держатели procurement.manage (менеджеры есть, сотрудник без права — нет, неактивный — нет).
    await setRule(UNALLOCATED, true, {});
    const byDefault = ids(await repo.ruleRecipients(await repo.loadRule(UNALLOCATED), 'procurement.manage', ['procurement.view']));
    expect(byDefault).toEqual(expect.arrayContaining([managerId, viewerOnlyId]));
    expect(byDefault).not.toContain(noViewId);
    expect(byDefault).not.toContain(inactiveId);
    // Свои получатели: пользователь + роль без права → роль отсечена правом, пользователь остаётся.
    await setRule(UNALLOCATED, true, { userIds: [managerId, noViewId, inactiveId], roleCodes: [noViewRoleCode] });
    const rule = await repo.loadRule(UNALLOCATED);
    expect(rule).toMatchObject({ isEnabled: true, userIds: [managerId, noViewId, inactiveId], roleCodes: [noViewRoleCode] });
    expect(ids(await repo.ruleRecipients(rule, 'procurement.manage', ['procurement.view']))).toEqual([managerId]);
    // Сводка дефицита требует procurement.manage: у роли 10 его убрали — менеджер выпадает.
    await grant(10, 'procurement.manage', false);
    try {
      expect(ids(await repo.ruleRecipients(rule, 'procurement.manage', ['procurement.manage']))).toEqual([]);
    } finally {
      await grant(10, 'procurement.manage', true);
    }
    // Сброс: {} → снова умолчание, хеш меняется.
    await setRule(UNALLOCATED, true, {});
    const reset = await repo.loadRule(UNALLOCATED);
    expect(reset).toMatchObject({ roleCodes: [], userIds: [] });
    expect(reset.recipientsHash).not.toBe(rule.recipientsHash);
    await setRule(UNALLOCATED, false, {});
  });

  it('guarded write: rule off or recipients changed → nothing written; a PATCH in flight is waited for (FOR SHARE on the rule row)', async () => {
    const repo = new PgProcurementNotificationsRepository(database);
    await setRule(UNALLOCATED, true, { userIds: [managerId] });
    const rule = await repo.loadRule(UNALLOCATED);
    const guard = { ruleCode: UNALLOCATED, recipientsHash: rule.recipientsHash };
    const input = (key: string) => ({ eventType: 'procurement.receipt_unallocated' as const, aggregateType: 'user', aggregateId: String(managerId), key,
      userId: managerId, title: 'Нераспределённые поступления', message: 'тест', entityType: 'procurement_receipts', entityId: null });
    const exists = async (key: string) => Number((await conn.query(
      `SELECT (SELECT count(*) FROM outbox_events WHERE idempotency_key = $1) + (SELECT count(*) FROM notifications WHERE idempotency_key = $1 || ':in_app') AS c`, [key])).rows[0].c);

    // Выключение, начатое ДО записи и ещё не закоммиченное: запись ждёт и видит выключенное правило.
    const k1 = `${tag}:off:${randomUUID()}`;
    await other.query('BEGIN');
    await other.query('UPDATE notification_rules SET is_enabled = false WHERE rule_code = $1', [UNALLOCATED]);
    const pending = repo.writeServiceNotification(input(k1), guard);
    await waitForLockWait('FOR SHARE');
    await other.query('COMMIT');
    expect(await pending).toBe(false);
    expect(await exists(k1)).toBe(0);

    // Смена получателей, начатая до записи: запись по старому хешу пропускается.
    await setRule(UNALLOCATED, true, { userIds: [managerId] });
    const fresh = await repo.loadRule(UNALLOCATED);
    const k2 = `${tag}:recipients:${randomUUID()}`;
    await other.query('BEGIN');
    await other.query(`UPDATE notification_rules SET recipients_json = '{"userIds": [${viewerOnlyId}]}'::jsonb WHERE rule_code = $1`, [UNALLOCATED]);
    const pending2 = repo.writeServiceNotification(input(k2), { ruleCode: UNALLOCATED, recipientsHash: fresh.recipientsHash });
    await waitForLockWait('FOR SHARE');
    await other.query('COMMIT');
    expect(await pending2).toBe(false);
    expect(await exists(k2)).toBe(0);

    // Обратный порядок (code review R1-1): запись держит FOR SHARE и стоит на паузе до вставок → PATCH выключения ждёт;
    // запись завершается парой outbox + уведомление, затем PATCH проходит; выключение после записи её не отменяет.
    await setRule(UNALLOCATED, true, { userIds: [managerId] });
    let locked!: () => void;
    let release!: () => void;
    const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const paused = new PgProcurementNotificationsRepository(database, { afterRuleLocked: async () => { locked(); await releaseSignal; } });
    const current = await paused.loadRule(UNALLOCATED);
    const k3 = `${tag}:ok:${randomUUID()}`;
    const writing = paused.writeServiceNotification(input(k3), { ruleCode: UNALLOCATED, recipientsHash: current.recipientsHash });
    await lockedSignal;
    let patched = false;
    const patch = other.query('UPDATE notification_rules SET is_enabled = false WHERE rule_code = $1 /* e2e-patch */', [UNALLOCATED])
      .then(() => { patched = true; });
    await waitForLockWait('e2e-patch');
    expect(patched).toBe(false);
    release();
    expect(await writing).toBe(true);
    await patch;
    expect(patched).toBe(true);
    expect(await exists(k3)).toBe(2);
    expect((await conn.query('SELECT is_enabled FROM notification_rules WHERE rule_code = $1', [UNALLOCATED])).rows[0].is_enabled).toBe(false);
    await setRule(UNALLOCATED, false, {});
  });

  it('outbox + notification are one atomic pair: concurrent writers create one pair; a failing notification insert rolls back the event', async () => {
    const a = new PgProcurementNotificationsRepository(database);
    const b = new PgProcurementNotificationsRepository(database2);
    const key = `${tag}:pair:${randomUUID()}`;
    const input = { eventType: 'procurement.receipt_unallocated' as const, aggregateType: 'user', aggregateId: String(managerId), key,
      userId: managerId, title: 'Нераспределённые поступления', message: 'тест', entityType: 'procurement_receipts', entityId: null };
    const results = await Promise.all([a.writeServiceNotification(input), b.writeServiceNotification(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(Number((await conn.query('SELECT count(*) AS c FROM outbox_events WHERE idempotency_key = $1', [key])).rows[0].c)).toBe(1);
    expect(Number((await conn.query('SELECT count(*) AS c FROM notifications WHERE idempotency_key = $1', [`${key}:in_app`])).rows[0].c)).toBe(1);
    // Несуществующий получатель: вставка уведомления падает (FK) → событие тоже откатывается.
    const broken = `${tag}:broken:${randomUUID()}`;
    await expect(a.writeServiceNotification({ ...input, key: broken, userId: 2_000_000_000 })).rejects.toBeTruthy();
    expect(Number((await conn.query('SELECT count(*) AS c FROM outbox_events WHERE idempotency_key = $1', [broken])).rows[0].c)).toBe(0);
  });

  it('daily unallocated summary: only the configured recipient, one pair per user and date, aggregate user; a second run adds nothing', async () => {
    const repo = new PgProcurementNotificationsRepository(database);
    const workspace = new PgProcurementWorkspaceRepository(database);
    const today = todayInAlmaty();
    const now = new Date(`${today}T18:00:00Z`); // 23:00 Almaty — после времени сводки
    const smt = Number((await conn.query('SELECT sheet_material_type_id FROM sheet_material_types ORDER BY 1 LIMIT 1')).rows[0].sheet_material_type_id);
    const sourceId = Number((await conn.query(`INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
      [`e2e-${randomUUID().slice(0, 8)}`, tag])).rows[0].source_id);
    for (const daysAgo of [4, 12]) {
      const documentId = Number((await conn.query(
        `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
         VALUES ($1, 'purchase_receipt', $2, $3, $4::date, true, $5, 100) RETURNING onec_document_id`,
        [sourceId, randomUUID(), `${tag.slice(-8)}-${daysAgo}`, addDays(today, -daysAgo), `${tag} Поставщик`])).rows[0].onec_document_id);
      await conn.query(`INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
        VALUES ($1, 1, 'лист', 2, 'sheet', $2)`, [documentId, smt]);
    }
    await setRule(UNALLOCATED, true, { userIds: [managerId] });
    try {
      const service = new ProcurementNotificationsService({
        repository: repo, worklist: workspace, enabled: () => true, supplierRequestsEnabled: () => true, now: () => now,
      });
      const first = await service.runOnce();
      expect(first.unallocated).toBe(1);
      expect(first.rulesEnabled).toMatchObject({ unallocated: true });
      const rows = (await conn.query(
        `SELECT user_id, title, message, entity_type, entity_id, idempotency_key FROM notifications
          WHERE source_type = 'procurement_digest' AND idempotency_key LIKE 'procurement_unallocated_digest:%' AND created_at >= $1`, [startedAt])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: String(managerId), entity_type: 'procurement_receipts', entity_id: null,
        idempotency_key: `procurement_unallocated_digest:${managerId}:${today}:in_app` });
      expect(rows[0].title).toBe(`Нераспределённые поступления на ${today.split('-').reverse().join('.')}`);
      expect(rows[0].message).toContain(`${tag.slice(-8)}-12`);
      expect(rows[0].message).toMatch(/из них старше 7 дней — \d+/);
      const event = (await conn.query('SELECT aggregate_type, aggregate_id, status FROM outbox_events WHERE idempotency_key = $1',
        [`procurement_unallocated_digest:${managerId}:${today}`])).rows;
      expect(event).toEqual([{ aggregate_type: 'user', aggregate_id: String(managerId), status: 'processed' }]);
      expect((await service.runOnce()).unallocated).toBe(0);
    } finally {
      await setRule(UNALLOCATED, false, {});
    }
  });
});
