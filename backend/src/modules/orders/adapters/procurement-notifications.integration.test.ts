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
import { ProcurementNotificationsService } from '../application/procurement-notifications.service';
import { addDays, todayInAlmaty } from '../domain/procurement-worklist';
import { PgProcurementNotificationsRepository } from './pg-procurement-notifications-repository';
import { PgProcurementWorkspaceRepository } from './pg-procurement-workspace-repository';
import { PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';

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

  describe('phase 4b-2: scheduled procurement notifications', () => {
    const material = async () => Number((await conn.query('SELECT sheet_material_type_id FROM order_details WHERE order_id = $1 LIMIT 1', [ownOrder])).rows[0].sheet_material_type_id);

    it('§5.7 p.2: the scanner emits one «demand changed after mark» event per change; a repeat pass adds nothing', async () => {
      const notifications = new PgProcurementNotificationsRepository(database);
      const smt = await material();
      await conn.query(
        `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id, purchased, origin, quantity_at_mark, unit_at_mark,
           demand_fingerprint_at_mark, marked_at, marked_by, version)
         VALUES ($1, 'sheet_material', $2, true, 'manual', 0.5, 'm2', repeat('0', 64), now(), $3, 1)`, [ownOrder, smt, adminId]);
      const events = async () => (await conn.query(
        `SELECT idempotency_key, payload_json FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = $1`,
        [String(ownOrder)])).rows;
      try {
        await notifications.scanDemandChanges(async () => true);
        const first = await events();
        expect(first).toHaveLength(1);
        expect(first[0].idempotency_key).toMatch(new RegExp(`^procurement_demand_changed:${ownOrder}:sheet_material:${smt}:[0-9a-f]{64}$`));
        expect(first[0].payload_json).toMatchObject({ orderId: ownOrder, resourceKey: `sheet_material:${smt}`, quantityAtMark: 0.5, unitAtMark: 'm2' });
        await notifications.scanDemandChanges(async () => true);
        expect(await events()).toHaveLength(1);
      } finally {
        await conn.query(`DELETE FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = $1`, [String(ownOrder)]);
        await conn.query('DELETE FROM order_resource_procurement WHERE order_id = $1', [ownOrder]);
      }
    });

    it('CR1-4: demand and marks come from one snapshot — a re-mark between the two reads does not produce a false event', async () => {
      const notifications = new PgProcurementNotificationsRepository(database);
      const smt = await material();
      const admin: CurrentUser = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: ['orders.view'] };
      const card = await new PgOrderResourceDemandRepository(database).getCard({ currentUser: admin, orderId: ownOrder }, { procurementEnabled: true });
      const fingerprint = card.data.lines.find((line) => line.resourceKey === `sheet_material:${smt}`)!.demandFingerprint;
      // Отметка совпадает с текущей потребностью — изменения нет.
      await conn.query(
        `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id, purchased, origin, quantity_at_mark, unit_at_mark,
           demand_fingerprint_at_mark, marked_at, marked_by, version)
         VALUES ($1, 'sheet_material', $2, true, 'manual', 0.5, 'm2', $3, now(), $4, 1)`, [ownOrder, smt, fingerprint, adminId]);
      const events = async () => Number((await conn.query(
        `SELECT count(*) FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = $1`, [String(ownOrder)])).rows[0].count);
      try {
        // Между чтением потребности и отметок отметку «переставили» (другой отпечаток): в снимке сканера её не видно.
        await notifications.scanDemandChanges(async () => true, {
          afterProjection: async () => {
            await conn.query(`UPDATE order_resource_procurement SET demand_fingerprint_at_mark = repeat('1', 64) WHERE order_id = $1`, [ownOrder]);
          },
        });
        expect(await events()).toBe(0);
        // Следующий проход видит уже новую отметку (не совпадает с потребностью) — одно событие.
        await notifications.scanDemandChanges(async () => true);
        expect(await events()).toBe(1);
        // Выключили посреди прохода — ничего не пишется.
        await conn.query(`DELETE FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = $1`, [String(ownOrder)]);
        await notifications.scanDemandChanges(async () => false);
        expect(await events()).toBe(0);
      } finally {
        await conn.query(`DELETE FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = $1`, [String(ownOrder)]);
        await conn.query('DELETE FROM order_resource_procurement WHERE order_id = $1', [ownOrder]);
      }
    });

    it('CR1-1: batches walk through every order and every receipt (batch size 1)', async () => {
      const notifications = new PgProcurementNotificationsRepository(database, { demandBatch: 1, receiptBatch: 1 });
      const smt = await material();
      for (const orderId of [ownOrder, foreignOrder]) {
        await conn.query(
          `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id, purchased, origin, quantity_at_mark, unit_at_mark,
             demand_fingerprint_at_mark, marked_at, marked_by, version)
           VALUES ($1, 'sheet_material', $2, true, 'manual', 0.5, 'm2', repeat('0', 64), now(), $3, 1)`, [orderId, smt, adminId]);
      }
      const today = todayInAlmaty();
      const sourceId = Number((await conn.query(`INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
        [`e2e-${randomUUID().slice(0, 8)}`, tag])).rows[0].source_id);
      const docs: number[] = [];
      for (const daysAgo of [6, 7]) {
        const documentId = Number((await conn.query(
          `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
           VALUES ($1, 'purchase_receipt', $2, $3, $4::date, true, $5, 100) RETURNING onec_document_id`,
          [sourceId, randomUUID(), `${tag.slice(-8)}-b${daysAgo}`, addDays(today, -daysAgo), `${tag} Поставщик`])).rows[0].onec_document_id);
        await conn.query(`INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
          VALUES ($1, 1, 'лист', 1, 'sheet', $2)`, [documentId, smt]);
        docs.push(documentId);
      }
      try {
        await notifications.scanDemandChanges(async () => true);
        const orders = (await conn.query(
          `SELECT DISTINCT aggregate_id FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = ANY($1::text[])`,
          [[String(ownOrder), String(foreignOrder)]])).rows.map((row) => Number(row.aggregate_id)).sort((a, b) => a - b);
        expect(orders).toEqual([ownOrder, foreignOrder].sort((a, b) => a - b));
        const seen: number[] = [];
        let after: { docDate: string; documentId: number } | null = null;
        for (;;) {
          const page = await notifications.unallocatedReceipts(addDays(today, -2), addDays(today, -32), after);
          if (page.length === 0) break;
          expect(page).toHaveLength(1);
          seen.push(page[0].documentId);
          after = { docDate: page[0].docDate, documentId: page[0].documentId };
        }
        expect(docs.every((documentId) => seen.includes(documentId))).toBe(true);
      } finally {
        await conn.query(`DELETE FROM outbox_events WHERE event_type = 'order.resource_demand_changed_after_mark' AND aggregate_id = ANY($1::text[])`,
          [[String(ownOrder), String(foreignOrder)]]);
        await conn.query('DELETE FROM order_resource_procurement WHERE order_id = ANY($1::bigint[])', [[ownOrder, foreignOrder]]);
      }
    });

    it('§5.7 p.4: unallocated receipts — older than the threshold, within the window, with an unallocated remainder only', async () => {
      const notifications = new PgProcurementNotificationsRepository(database);
      const smt = await material();
      const today = todayInAlmaty();
      const sourceId = Number((await conn.query(`INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
        [`e2e-${randomUUID().slice(0, 8)}`, tag])).rows[0].source_id);
      const receipt = async (daysAgo: number) => {
        const documentId = Number((await conn.query(
          `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
           VALUES ($1, 'purchase_receipt', $2, $3, $4::date, true, $5, 100) RETURNING onec_document_id`,
          [sourceId, randomUUID(), `${tag.slice(-8)}-${daysAgo}`, addDays(today, -daysAgo), `${tag} Поставщик`])).rows[0].onec_document_id);
        const lineId = Number((await conn.query(
          `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
           VALUES ($1, 1, 'лист', 2, 'sheet', $2) RETURNING onec_document_line_id`, [documentId, smt])).rows[0].onec_document_line_id);
        return { documentId, lineId };
      };
      const fresh = await receipt(1);
      const due = await receipt(5);
      const old = await receipt(60);
      const found = async () => (await notifications.unallocatedReceipts(addDays(today, -2), addDays(today, -32)))
        .filter((row) => [fresh.documentId, due.documentId, old.documentId].includes(row.documentId));
      const before = await found();
      expect(before.map((row) => row.documentId)).toEqual([due.documentId]);
      expect(before[0]).toMatchObject({ lines: 1, supplierName: `${tag} Поставщик` });
      // Распределили часть — другой остаток (новый хеш); всё — документ уходит.
      const procurementId = Number((await conn.query(
        `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id) VALUES ($1, 'sheet_material', $2) RETURNING order_resource_procurement_id`,
        [ownOrder, smt])).rows[0].order_resource_procurement_id);
      try {
        await conn.query(`INSERT INTO order_resource_onec_allocations (order_resource_procurement_id, onec_document_line_id, role, quantity, unit_code, origin, created_by)
          VALUES ($1, $2, 'receipt', 1, 'sheet', 'manual', $3)`, [procurementId, due.lineId, adminId]);
        const partial = await found();
        expect(partial[0].remainingHash).not.toBe(before[0].remainingHash);
        await conn.query(`UPDATE order_resource_onec_allocations SET quantity = 2 WHERE onec_document_line_id = $1`, [due.lineId]);
        expect(await found()).toEqual([]);
      } finally {
        await conn.query('DELETE FROM order_resource_onec_allocations WHERE order_resource_procurement_id = $1', [procurementId]);
        await conn.query('DELETE FROM order_resource_procurement WHERE order_resource_procurement_id = $1', [procurementId]);
      }
    });

    it('§5.7 p.4: the digest goes to procurement.manage holders under their own scope, once a day, readable only with procurement.view', async () => {
      const notifications = new PgProcurementNotificationsRepository(database);
      const workspace = new PgProcurementWorkspaceRepository(database);
      const now = new Date(`${todayInAlmaty()}T18:00:00Z`); // 23:00 Almaty — после времени сводки
      const set = (code: string, value: boolean) => conn.query('UPDATE notification_rules SET is_enabled = $2 WHERE rule_code = $1', [code, value]);
      const manageBefore = (await conn.query(`SELECT is_enabled FROM role_permissions WHERE role_id = 10 AND permission_name = 'procurement.manage'`)).rows[0]?.is_enabled;
      const setManage = (enabled: boolean) => conn.query(
        `INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES (10, 'procurement.manage', $1)
         ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`, [enabled]);
      const startedAt = new Date();
      await setManage(true);
      await set('procurement-deficit-digest', true);
      try {
        const service = new ProcurementNotificationsService({
          repository: notifications, worklist: workspace, enabled: () => true, supplierRequestsEnabled: () => true, now: () => now,
        });
        const first = await service.runOnce();
        const holder = (await notifications.permissionHolders('procurement.manage')).find((user) => Number(user.id) === managerId)!;
        expect(holder).toBeDefined();
        const own = await workspace.listWorklist(holder, { preset: 'all', groupBy: 'none', sort: 'due' },
          { procurementEnabled: true, supplyWorkspaceEnabled: true, supplierRequestsEnabled: true });
        const rows = (await conn.query(
          `SELECT title, message, entity_type, entity_id FROM notifications WHERE user_id = $1 AND source_type = 'procurement_digest'`, [managerId])).rows;
        if (own.totals.uncovered > 0) {
          expect(rows).toHaveLength(1);
          expect(rows[0].message).toContain(`Не покрыто позиций: ${own.totals.uncovered}, из них срочно: ${own.totals.urgent}.`);
          expect(rows[0]).toMatchObject({ entity_type: 'procurement_worklist', entity_id: null });
          expect(rows[0].message).not.toContain(tag);
        } else {
          expect(rows).toHaveLength(0);
        }
        expect(first.digests).toBeGreaterThanOrEqual(rows.length);
        // Повтор в тот же день — ничего нового.
        expect((await service.runOnce()).digests).toBe(0);
      } finally {
        await set('procurement-deficit-digest', false);
        if (manageBefore !== undefined) await setManage(manageBefore);
        await conn.query(`DELETE FROM notifications WHERE source_type = 'procurement_digest' AND created_at >= $1`, [startedAt]);
        await conn.query(`DELETE FROM outbox_events WHERE event_type = 'procurement.deficit_digest' AND created_at >= $1`, [startedAt]);
      }
    });

    it('CR2-1: digest totals are computed in batches with the worklist rules — equal to the screen totals at any batch size', async () => {
      const workspace = new PgProcurementWorkspaceRepository(database);
      const options = { procurementEnabled: true, supplyWorkspaceEnabled: true, supplierRequestsEnabled: true };
      const admin: CurrentUser = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: ['orders.view', 'procurement.view'] };
      for (const viewer of [manager, admin]) {
        // Владельческая БД мала — экран не упирается в лимиты, сравнение обязательно (CR3-1).
        const screen = await workspace.listWorklist(viewer, { preset: 'all', groupBy: 'none', sort: 'due' }, options);
        const byOne = await workspace.worklistTotals(viewer, options, 1);
        const byDefault = await workspace.worklistTotals(viewer, options);
        expect(byOne).toEqual(byDefault);
        expect(byOne.uncovered).toBe(screen.totals.uncovered);
        expect(byOne.urgent).toBe(screen.totals.urgent);
        expect(byOne.deficitM2).toBeCloseTo(screen.totals.deficitM2, 2);
        expect(byOne.deficitLm).toBeCloseTo(screen.totals.deficitLm, 2);
      }
    });

    it('§5.7 p.4: a service notification is written with its outbox event exactly once per key', async () => {
      const notifications = new PgProcurementNotificationsRepository(database);
      const key = `procurement_unallocated:${managerId}:1:${randomUUID()}`;
      const input = { eventType: 'procurement.receipt_unallocated' as const, aggregateType: 'onec_document', aggregateId: '1', key,
        userId: managerId, title: 'Поступление не распределено', message: 'тест', entityType: 'onec_document', entityId: '1' };
      try {
        expect(await notifications.writeServiceNotification(input)).toBe(true);
        expect(await notifications.writeServiceNotification(input)).toBe(false);
        const event = (await conn.query('SELECT status FROM outbox_events WHERE idempotency_key = $1', [key])).rows;
        expect(event).toEqual([{ status: 'processed' }]);
        const listed = await repository.listForUser({ viewer: manager, unreadOnly: false, page: 1, pageSize: 50 });
        expect(listed.data.filter((row) => row.sourceType === 'procurement_digest' && row.message === 'тест')).toHaveLength(1);
        const hidden = await repository.listForUser({ viewer: { ...manager, permissions: ['orders.view'] }, unreadOnly: false, page: 1, pageSize: 50 });
        expect(hidden.data.filter((row) => row.sourceType === 'procurement_digest')).toEqual([]);
      } finally {
        await conn.query('DELETE FROM notifications WHERE idempotency_key = $1', [`${key}:in_app`]);
        await conn.query('DELETE FROM outbox_events WHERE idempotency_key = $1', [key]);
      }
    });
  });
});
