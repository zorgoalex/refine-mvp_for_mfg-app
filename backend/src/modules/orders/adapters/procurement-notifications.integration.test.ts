import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgProcurementRecipientVisibility } from '../../notifications-engine/adapters/pg-procurement-recipient-visibility';
import { PgNotificationRepository } from '../../notifications/adapters/pg-notification-repository';
import { PgNotificationContextBuilder } from '../../notifications-engine/adapters/pg-notification-context';
import { PgNotificationChannelDeliveryAdapter } from '../../notifications-engine/adapters/pg-notification-channel-delivery';
import { PgNotificationRuleRepository } from '../../notifications-engine/adapters/pg-notification-rule-repository';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { PgOutboxRepository } from '../../notifications-engine/adapters/pg-outbox-repository';
import { PgRecipientSourceAdapter } from '../../notifications-engine/adapters/pg-recipient-source';
import { PgVisibilityAdapter } from '../../notifications-engine/adapters/pg-visibility';
import { NotificationRuleEngineService } from '../../notifications-engine/application/notification-rule-engine.service';
import { OutboxRelayService } from '../../notifications-engine/application/outbox-relay.service';
import { RecipientResolverService } from '../../notifications-engine/application/recipient-resolver.service';

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/procurement-notifications-4b/run-races.cjs).
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;

describe.skipIf(!url)('Procurement notifications (phase 4b) — real PostgreSQL', { timeout: 60000 }, () => {
  let pool: Pool;
  let conn: PoolClient;
  const tag = 'E2E-Тест-УВ-' + randomUUID().slice(0, 8);
  let adminId: number;
  let managerId: number;
  let ownOrder: number;
  let foreignOrder: number;
  let manager: CurrentUser;
  let repository: PgNotificationRepository;
  let database: DatabaseService;
  let procurementVisibility: PgProcurementRecipientVisibility;

  const user = async (suffix: string, roleId: number) => Number((await conn.query(
    `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', $3) RETURNING user_id`,
    [`${tag}-${suffix}`, `${tag}-${suffix}@example.invalid`, roleId])).rows[0].user_id);

  const order = async (index: number, createdBy: number, managerUserId: number | null) => {
    await conn.query('BEGIN');
    const clientId = Number((await conn.query('SELECT client_id FROM clients WHERE client_name = $1', [tag])).rows[0].client_id);
    const projectId = Number((await conn.query('SELECT project_id FROM projects WHERE name = $1', [tag])).rows[0].project_id);
    const orderId = Number((await conn.query(
      `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, manager_id)
       VALUES ($1, $2, $3, 1, 1, $4, $5) RETURNING order_id`,
      [`${tag}-${index}`, clientId, projectId, createdBy, managerUserId])).rows[0].order_id);
    const milling = Number((await conn.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    const edge = Number((await conn.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const material = Number((await conn.query('SELECT sheet_material_type_id FROM sheet_material_types ORDER BY 1 LIMIT 1')).rows[0].sheet_material_type_id);
    await conn.query(
      `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
       VALUES ($1, 1, 1000, 1000, 1, 1, $2, $3, $4, $5)`, [orderId, material, milling, edge, createdBy]);
    await conn.query('COMMIT');
    return orderId;
  };

  const notify = async (sourceType: string, entityType: string | null, entityId: string | null) => String((await conn.query(
    `INSERT INTO notifications (user_id, level, title, message, entity_type, entity_id, source_type, source_id, idempotency_key)
     VALUES ($1, 'info', $2, $2, $3, $4, $5, NULL, $6) RETURNING notification_id`,
    [managerId, `${tag} ${sourceType}`, entityType, entityId, sourceType, `${tag}:${randomUUID()}`])).rows[0].notification_id);
  const isRead = async (id: string) => (await conn.query('SELECT is_read FROM notifications WHERE notification_id = $1', [id])).rows[0].is_read;

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    conn = await pool.connect();
    adminId = await user('admin', 1);
    managerId = await user('manager', 10);
    await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
    await conn.query('SELECT set_config($1, $2, false)', ['hasura.user', JSON.stringify({ 'x-hasura-user-id': String(adminId), 'x-hasura-role': 'admin' })]);
    const clientId = Number((await conn.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    await conn.query('INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4)',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId]);
    // «Свой» заказ менеджера (scope own: manager_id) и чужой.
    ownOrder = await order(1, adminId, managerId);
    foreignOrder = await order(2, adminId, null);
    manager = { id: String(managerId), username: `${tag}-manager`, role: 'manager', roleId: 10, permissions: ['orders.view', 'procurement.view'] };
    repository = new PgNotificationRepository(conn);
    // Пул из ОДНОГО соединения — для реле (CR2-1: матрица ролей читается через соединение транзакции).
    database = new DatabaseService(new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
    } as Partial<BackendEnv>), { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    procurementVisibility = new PgProcurementRecipientVisibility();
  }, 60000);

  afterAll(async () => {
    await database?.onModuleDestroy().catch(() => undefined);
    try { conn?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('R5-1/R6-2: procurement notifications follow the current right and order scope on list, count, read, read-all and delete', async () => {
    const own = await notify('procurement_order_event', 'order', String(ownOrder));
    const foreign = await notify('procurement_order_event', 'order', String(foreignOrder));
    const digest = await notify('procurement_digest', null, null);
    const deadline = await notify('deadline', 'order', String(foreignOrder));
    const titles = async (viewer: CurrentUser) => (await repository.listForUser({ viewer, unreadOnly: false, page: 1, pageSize: 50 }));

    const visible = await titles(manager);
    expect(visible.data.map((row) => row.notificationId).sort()).toEqual([own, digest, deadline].sort());
    expect(visible.unreadCount).toBe(3);
    expect(await repository.markReadForUser({ notificationId: foreign, viewer: manager })).toBeNull();
    expect(await repository.deleteForUser({ notificationId: foreign, viewer: manager })).toBe(false);

    // Право снято: видно только прочие уведомления; «прочитать всё» не трогает скрытые и не считает их.
    const revoked: CurrentUser = { ...manager, permissions: ['orders.view'] };
    const hidden = await titles(revoked);
    expect(hidden.data.map((row) => row.notificationId)).toEqual([deadline]);
    expect(hidden.unreadCount).toBe(1);
    expect(await repository.markAllReadForUser(revoked)).toBe(1);
    expect(await isRead(own)).toBe(false);
    expect(await isRead(digest)).toBe(false);
    expect(await isRead(foreign)).toBe(false);
    expect(await repository.markReadForUser({ notificationId: own, viewer: revoked })).toBeNull();

    // Право вернули — снова видны и непрочитаны; чужой заказ по-прежнему скрыт.
    const restored = await titles(manager);
    expect(restored.data.map((row) => row.notificationId).sort()).toEqual([own, digest, deadline].sort());
    expect(restored.unreadCount).toBe(2);
    expect(await repository.markAllReadForUser(manager)).toBe(2);
    expect(await isRead(foreign)).toBe(false);

    // Заказ ушёл в корзину — его уведомление закупа скрывается.
    await conn.query('UPDATE orders SET delete_flag = true WHERE order_id = $1', [ownOrder]);
    expect((await titles(manager)).data.map((row) => row.notificationId)).not.toContain(own);
    await conn.query('UPDATE orders SET delete_flag = false WHERE order_id = $1', [ownOrder]);
    await conn.query('DELETE FROM notifications WHERE idempotency_key LIKE $1', [`${tag}:%`]);
  });

  it('§5.7: the seeded rule (once enabled) notifies the order manager of a receipt allocation only; flag off or a stale event — nothing', async () => {
    const seeded = (await conn.query(`SELECT is_enabled, channels_json FROM notification_rules WHERE rule_code = 'procurement-material-arrived'`)).rows[0];
    expect(seeded).toMatchObject({ is_enabled: false, channels_json: ['in_app'] });
    let flag = false;
    const engine = new NotificationRuleEngineService({
      ruleRepo: new PgNotificationRuleRepository(),
      contextBuilder: new PgNotificationContextBuilder(),
      recipientResolver: new RecipientResolverService(new PgRecipientSourceAdapter(), new PgVisibilityAdapter()),
      notificationWrite: new PgNotificationWriteAdapter(),
      channelDelivery: new PgNotificationChannelDeliveryAdapter(),
      runtimeConfig: { isEngineOwnsDeadline: () => false, isFeatureEnabled: () => flag },
      procurementVisibility,
    });
    const outbox = new PgOutboxRepository();
    const enqueue = async (payload: Record<string, unknown>, createdAt = 'now()') => String((await conn.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, created_at, next_attempt_at)
       VALUES ('order.resource_procurement_changed', 'order', $1, $2::jsonb, $3, ${createdAt}, now() - interval '1 second')
       RETURNING outbox_event_id`,
      [String(ownOrder), JSON.stringify({ orderId: ownOrder, ...payload }), `${tag}:${randomUUID()}`])).rows[0].outbox_event_id);
    const run = async (id: string) => {
      const claimed = await outbox.claimPendingBatch(conn, { batchSize: 1000, workerId: tag, now: new Date() });
      const record = claimed.find((entry) => entry.outboxEventId === id)!;
      // Чужие события прогона не трогаем — вернуть в очередь.
      const others = claimed.filter((entry) => entry.outboxEventId !== id).map((entry) => entry.outboxEventId);
      if (others.length > 0) await conn.query(`UPDATE outbox_events SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE outbox_event_id = ANY($1::uuid[])`, [others]);
      expect(record.createdAt).toBeDefined();
      return engine.processEvent(conn, record);
    };
    const created = async () => Number((await conn.query(
      `SELECT count(*) FROM notifications WHERE source_type = 'procurement_order_event' AND entity_id = $1`, [String(ownOrder)])).rows[0].count);

    await conn.query(`UPDATE notification_rules SET is_enabled = true WHERE rule_code = 'procurement-material-arrived'`);
    try {
      // Флаг выключен в момент обработки — ничего.
      expect((await run(await enqueue({ changeType: 'allocation_added', role: 'receipt' }))).skipped).toBe('skipped_disabled');
      flag = true;
      // Устаревшее событие (реле стояло) — ничего.
      expect((await run(await enqueue({ changeType: 'allocation_added', role: 'receipt' }, "now() - interval '2 days'"))).skipped).toBe('skipped_stale');
      // Оплата, отметка, снятие — не «материал пришёл».
      for (const payload of [{ changeType: 'allocation_added', role: 'payment' }, { changeType: 'marked' }, { changeType: 'allocation_removed', role: 'receipt' }]) {
        expect(await run(await enqueue(payload))).toEqual({ matched: 0, created: 0 });
      }
      expect(await created()).toBe(0);
      // Приход — уведомление ответственному по заказу; повтор того же события — без дубля.
      const arrived = await enqueue({ changeType: 'allocation_added', role: 'receipt' });
      expect(await run(arrived)).toEqual({ matched: 1, created: 1 });
      const row = (await conn.query(`SELECT user_id, source_type, entity_type, title FROM notifications WHERE source_type = 'procurement_order_event' AND entity_id = $1`, [String(ownOrder)])).rows[0];
      expect(row).toMatchObject({ user_id: String(managerId), source_type: 'procurement_order_event', entity_type: 'order', title: 'Материал пришёл по заказу' });
      const replay = await engine.processEvent(conn, { outboxEventId: arrived, eventType: 'order.resource_procurement_changed', aggregateType: 'order',
        aggregateId: String(ownOrder), payload: { orderId: ownOrder, changeType: 'allocation_added', role: 'receipt' }, attempts: 0, createdAt: new Date().toISOString() });
      expect(replay).toEqual({ matched: 1, created: 0 });
      expect(await created()).toBe(1);
    } finally {
      await conn.query(`UPDATE notification_rules SET is_enabled = false WHERE rule_code = 'procurement-material-arrived'`);
      await conn.query('DELETE FROM notifications WHERE source_type = $1 AND entity_id = $2', ['procurement_order_event', String(ownOrder)]);
      await conn.query('DELETE FROM outbox_events WHERE idempotency_key LIKE $1', [`${tag}:%`]);
    }
    expect((await conn.query(`SELECT is_enabled FROM notification_rules WHERE rule_code = 'procurement-material-arrived'`)).rows[0].is_enabled).toBe(false);
  });

  it('CR1-1: recipients follow the live role matrix — scope widened to all, procurement.view revoked, assigned scope', async () => {
    const ctxFor = (orderId: number) => ({ orderId } as never);
    const scopeOf = async () => (await conn.query(`SELECT scope_value FROM role_policy_scopes WHERE role_id = 10 AND scope_key = 'orders.view'`)).rows[0]?.scope_value;
    const viewOf = async () => (await conn.query(`SELECT is_enabled FROM role_permissions WHERE role_id = 10 AND permission_name = 'procurement.view'`)).rows[0]?.is_enabled;
    const scopeBefore = await scopeOf();
    const viewBefore = await viewOf();
    const setScope = (value: string) => conn.query(
      `INSERT INTO role_policy_scopes (role_id, scope_key, scope_value) VALUES (10, 'orders.view', $1)
       ON CONFLICT (role_id, scope_key) DO UPDATE SET scope_value = EXCLUDED.scope_value`, [value]);
    const setView = (enabled: boolean) => conn.query(
      `INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES (10, 'procurement.view', $1)
       ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`, [enabled]);
    try {
      await setView(true);
      await setScope('own');
      expect(await procurementVisibility.filterByBaseVisibility(conn, [managerId], ctxFor(ownOrder))).toEqual([managerId]);
      expect(await procurementVisibility.filterByBaseVisibility(conn, [managerId], ctxFor(foreignOrder))).toEqual([]);
      // Роли расширили scope до «все» — чужой заказ тоже (статические умолчания дали бы own и потеряли получателя).
      await setScope('all');
      expect(await procurementVisibility.filterByBaseVisibility(conn, [managerId], ctxFor(foreignOrder))).toEqual([managerId]);
      // «Назначенные»: только заказ, где он ответственный по цеху.
      await setScope('assigned');
      expect(await procurementVisibility.filterByBaseVisibility(conn, [managerId], ctxFor(ownOrder))).toEqual([]);
      // Право снято — никому, даже на своём заказе; без заказа в событии — никому.
      await setScope('all');
      await setView(false);
      expect(await procurementVisibility.filterByBaseVisibility(conn, [managerId], ctxFor(ownOrder))).toEqual([]);
      await setView(true);
      expect(await procurementVisibility.filterByBaseVisibility(conn, [managerId], { orderId: null } as never)).toEqual([]);
    } finally {
      if (scopeBefore) await setScope(scopeBefore);
      if (viewBefore !== undefined) await setView(viewBefore);
    }
    expect(await scopeOf()).toBe(scopeBefore);
    expect(await viewOf()).toBe(viewBefore);
  });

  it('CR2-1: the real relay with a single-connection pool processes the event, writes one notification, a replay — no duplicate', async () => {
    let flag = true;
    const engine = new NotificationRuleEngineService({
      ruleRepo: new PgNotificationRuleRepository(),
      contextBuilder: new PgNotificationContextBuilder(),
      recipientResolver: new RecipientResolverService(new PgRecipientSourceAdapter(), new PgVisibilityAdapter()),
      notificationWrite: new PgNotificationWriteAdapter(),
      channelDelivery: new PgNotificationChannelDeliveryAdapter(),
      runtimeConfig: { isEngineOwnsDeadline: () => false, isFeatureEnabled: () => flag },
      procurementVisibility,
    });
    const relay = new OutboxRelayService({
      database,
      outboxRepo: new PgOutboxRepository(),
      consumers: [{ supports: (type) => type === 'order.resource_procurement_changed', process: async (client, event) => { await engine.processEvent(client, event); } }],
      config: { workerId: tag, batchSize: 500, maxAttempts: 3 },
    });
    const key = `${tag}:relay:${randomUUID()}`;
    const eventId = String((await conn.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, next_attempt_at)
       VALUES ('order.resource_procurement_changed', 'order', $1, $2::jsonb, $3, now() - interval '1 second') RETURNING outbox_event_id`,
      [String(ownOrder), JSON.stringify({ orderId: ownOrder, changeType: 'allocation_added', role: 'receipt' }), key])).rows[0].outbox_event_id);
    const count = async () => Number((await conn.query(
      `SELECT count(*) FROM notifications WHERE source_type = 'procurement_order_event' AND entity_id = $1`, [String(ownOrder)])).rows[0].count);
    await conn.query(`UPDATE notification_rules SET is_enabled = true WHERE rule_code = 'procurement-material-arrived'`);
    try {
      const summary = await relay.processBatchOnce();
      expect(summary.failed).toBe(0);
      expect((await conn.query('SELECT status FROM outbox_events WHERE outbox_event_id = $1', [eventId])).rows[0].status).toBe('processed');
      expect(await count()).toBe(1);
      // Повтор того же события (вернули в очередь) — без дубля.
      await conn.query(`UPDATE outbox_events SET status = 'pending', next_attempt_at = now() - interval '1 second' WHERE outbox_event_id = $1`, [eventId]);
      expect((await relay.processBatchOnce()).failed).toBe(0);
      expect(await count()).toBe(1);
      flag = false;
    } finally {
      await conn.query(`UPDATE notification_rules SET is_enabled = false WHERE rule_code = 'procurement-material-arrived'`);
      await conn.query('DELETE FROM notifications WHERE source_type = $1 AND entity_id = $2', ['procurement_order_event', String(ownOrder)]);
      await conn.query('DELETE FROM outbox_events WHERE idempotency_key = $1', [key]);
    }
  });
});
