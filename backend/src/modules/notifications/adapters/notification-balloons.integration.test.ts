import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgNotificationChannelDeliveryAdapter } from '../../notifications-engine/adapters/pg-notification-channel-delivery';
import { PgNotificationContextBuilder } from '../../notifications-engine/adapters/pg-notification-context';
import { PgNotificationRuleRepository } from '../../notifications-engine/adapters/pg-notification-rule-repository';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { PgOutboxRepository } from '../../notifications-engine/adapters/pg-outbox-repository';
import { PgRecipientSourceAdapter } from '../../notifications-engine/adapters/pg-recipient-source';
import { PgVisibilityAdapter } from '../../notifications-engine/adapters/pg-visibility';
import { NotificationRuleEngineService } from '../../notifications-engine/application/notification-rule-engine.service';
import { OutboxRelayService } from '../../notifications-engine/application/outbox-relay.service';
import { RecipientResolverService } from '../../notifications-engine/application/recipient-resolver.service';
import { PgProcurementNotificationsRepository } from '../../orders/adapters/pg-procurement-notifications-repository';
import { PgNotificationRepository } from './pg-notification-repository';

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/notification-balloons/run-races.cjs).
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;

describe.skipIf(!url)('Notification balloons (plan 2026-10-03) — real PostgreSQL', { timeout: 90000 }, () => {
  let pool: Pool;
  let conn: PoolClient;
  let other: PoolClient;
  let database: DatabaseService;
  const tag = 'E2E-Тест-БЛ-' + randomUUID().slice(0, 8);
  let userId: number;
  let viewer: CurrentUser;
  const write = new PgNotificationWriteAdapter();

  const insert = async (mode: 'auto' | 'persistent' | null, extra: { ageHours?: number; read?: boolean } = {}) => {
    const key = `${tag}:${randomUUID()}`;
    const { notificationId } = await write.insertIfAbsent(conn, {
      userId, level: 'info', title: tag, message: 'тест', entityType: null, entityId: null,
      sourceType: 'e2e', sourceId: null, idempotencyKey: key, balloonMode: mode,
    });
    if (extra.ageHours) await conn.query(`UPDATE notifications SET created_at = now() - make_interval(hours => $2) WHERE notification_id = $1`, [notificationId, extra.ageHours]);
    if (extra.read) await conn.query('UPDATE notifications SET is_read = true, read_at = now() WHERE notification_id = $1', [notificationId]);
    return notificationId;
  };
  const repoOn = (client: PoolClient) => new PgNotificationRepository(client);

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    conn = await pool.connect();
    other = await pool.connect();
    userId = Number((await conn.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 10) RETURNING user_id`,
      [`${tag}-u`, `${tag}-u@example.invalid`])).rows[0].user_id);
    viewer = { id: String(userId), username: `${tag}-u`, role: 'manager', roleId: 10, permissions: [] };
    database = new DatabaseService(new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
    } as Partial<BackendEnv>), { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
  }, 60000);

  afterAll(async () => {
    await conn?.query('DELETE FROM notifications WHERE user_id = $1', [userId]).catch(() => undefined);
    await conn?.query(`UPDATE notification_rules SET is_enabled = false, channels_json = '["in_app"]'::jsonb, balloon_mode = 'auto' WHERE rule_code = 'procurement-receipt-unallocated'`).catch(() => undefined);
    await database?.onModuleDestroy().catch(() => undefined);
    try { conn?.release(); } catch { /* released */ }
    try { other?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('claim gives only unshown unread balloon rows not older than 24 h; history, read and plain rows never', async () => {
    await conn.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    const fresh = await insert('persistent');
    await insert(null);
    await insert('auto', { ageHours: 25 });
    await insert('auto', { read: true });
    const token = randomUUID();
    const items = await repoOn(conn).claimBalloonsForUser({ viewer, token, limit: 5 });
    expect(items.map((item) => item.notificationId)).toEqual([fresh]);
    expect(items[0].balloonMode).toBe('persistent');
  });

  it('lost response: the same token gets its lease back first; another token waits for expiry; ack is final and owner-only', async () => {
    await conn.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    const a = await insert('auto');
    const b = await insert('auto');
    const tabA = randomUUID();
    const tabB = randomUUID();
    const first = await repoOn(conn).claimBalloonsForUser({ viewer, token: tabA, limit: 1 });
    expect(first.map((i) => i.notificationId)).toEqual([a]);
    // Ответ потерян: та же вкладка повторяет — сначала своя аренда.
    const retry = await repoOn(conn).claimBalloonsForUser({ viewer, token: tabA, limit: 1 });
    expect(retry.map((i) => i.notificationId)).toEqual([a]);
    // Другая вкладка аренду A не получает, получает B.
    const otherTab = await repoOn(other).claimBalloonsForUser({ viewer, token: tabB, limit: 5 });
    expect(otherTab.map((i) => i.notificationId)).toEqual([b]);
    // Чужой ack — no-op; свой — фиксирует показ.
    expect(await repoOn(conn).ackBalloonsForUser({ viewer, token: tabB, notificationIds: [a] })).toBe(0);
    expect(await repoOn(conn).ackBalloonsForUser({ viewer, token: tabA, notificationIds: [a] })).toBe(1);
    expect(await repoOn(conn).claimBalloonsForUser({ viewer, token: tabA, limit: 5 })).toEqual([]);
    // Аренда B истекла (не подтверждена) — другая вкладка получает её снова (повтор допустим, потеря — нет).
    await conn.query(`UPDATE notifications SET balloon_leased_at = now() - interval '3 minutes' WHERE notification_id = $1`, [b]);
    expect((await repoOn(conn).claimBalloonsForUser({ viewer, token: tabA, limit: 5 })).map((i) => i.notificationId)).toEqual([b]);
  });

  it('two tabs claiming at once never get the same row (SKIP LOCKED); more than 5 come in portions', async () => {
    await conn.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push(await insert('auto'));
    const [x, y] = await Promise.all([
      repoOn(conn).claimBalloonsForUser({ viewer, token: randomUUID(), limit: 5 }),
      repoOn(other).claimBalloonsForUser({ viewer, token: randomUUID(), limit: 5 }),
    ]);
    const all = [...x, ...y].map((i) => i.notificationId);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(7);
    expect(x.length).toBeLessThanOrEqual(5);
  });

  it('a notification committed late (after a claim ran) is claimed by the next claim', async () => {
    await conn.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    const token = randomUUID();
    await other.query('BEGIN');
    const late = (await write.insertIfAbsent(other, {
      userId, level: 'info', title: tag, message: 'поздний', entityType: null, entityId: null,
      sourceType: 'e2e', sourceId: null, idempotencyKey: `${tag}:late:${randomUUID()}`, balloonMode: 'auto',
    })).notificationId;
    expect(await repoOn(conn).claimBalloonsForUser({ viewer, token, limit: 5 })).toEqual([]);
    await other.query("SELECT pg_sleep(0.2)");
    await other.query('COMMIT');
    expect((await repoOn(conn).claimBalloonsForUser({ viewer, token, limit: 5 })).map((i) => i.notificationId)).toEqual([late]);
  });

  it('procurement writer reads the balloon from the rule row under FOR SHARE: a PATCH removing balloon before the write wins', async () => {
    const procurement = new PgProcurementNotificationsRepository(database);
    await conn.query(`UPDATE notification_rules SET is_enabled = true, channels_json = '["in_app","balloon"]'::jsonb, balloon_mode = 'persistent' WHERE rule_code = 'procurement-receipt-unallocated'`);
    const rule = await procurement.loadRule('procurement-receipt-unallocated');
    const guard = { ruleCode: rule.ruleCode, recipientsHash: rule.recipientsHash };
    const input = (key: string) => ({ eventType: 'procurement.receipt_unallocated' as const, aggregateType: 'user', aggregateId: String(userId), key,
      userId, title: tag, message: 'тест', entityType: 'procurement_receipts', entityId: null });
    const k1 = `${tag}:proc:${randomUUID()}`;
    expect(await procurement.writeServiceNotification(input(k1), guard)).toBe(true);
    expect((await conn.query('SELECT balloon_mode FROM notifications WHERE idempotency_key = $1', [`${k1}:in_app`])).rows[0].balloon_mode).toBe('persistent');
    // PATCH убрал балун после выборки прохода, до записи — запись без балуна.
    await conn.query(`UPDATE notification_rules SET channels_json = '["in_app"]'::jsonb WHERE rule_code = 'procurement-receipt-unallocated'`);
    const k2 = `${tag}:proc:${randomUUID()}`;
    expect(await procurement.writeServiceNotification(input(k2), guard)).toBe(true);
    expect((await conn.query('SELECT balloon_mode FROM notifications WHERE idempotency_key = $1', [`${k2}:in_app`])).rows[0].balloon_mode).toBeNull();
    await conn.query(`DELETE FROM outbox_events WHERE idempotency_key = ANY($1::text[])`, [[k1, k2]]);
  });

  it('deadline balloon end to end: DEADLINE_EXPIRED rule with a persistent balloon → real relay + engine → notification with the balloon → claimed by a tab', async () => {
    // Свой админ (видит все заказы) и свой заказ; правило — на этого пользователя, без требований к экземпляру дедлайна.
    const adminId = Number((await conn.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [`${tag}-admin`, `${tag}-admin@example.invalid`])).rows[0].user_id);
    const admin: CurrentUser = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: [] };
    await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
    const clientId = Number((await conn.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    const projectId = Number((await conn.query('INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId])).rows[0].project_id);
    // Заказ с деталью — в одной транзакции (отложенная проверка «у производственного заказа есть активная деталь»).
    await conn.query('BEGIN');
    const orderId = Number((await conn.query(
      `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, manager_id)
       VALUES ($1, $2, $3, 1, 1, $4, $4) RETURNING order_id`, [`${tag}-дедлайн`, clientId, projectId, adminId])).rows[0].order_id);
    await conn.query(
      `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
       SELECT $1, 1, 1000, 1000, 1, 1,
              (SELECT sheet_material_type_id FROM sheet_material_types ORDER BY 1 LIMIT 1),
              (SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1),
              (SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1), $2`, [orderId, adminId]);
    await conn.query('COMMIT');
    const ruleCode = `e2e-deadline-balloon-${randomUUID().slice(0, 8)}`;
    await conn.query(
      `INSERT INTO notification_rules (rule_code, event_type, level, priority, is_enabled, channels_json, balloon_mode, conditions_json, recipients_json, created_by_user_id, updated_by_user_id)
       VALUES ($1, 'DEADLINE_EXPIRED', 'warning', 100, true, '["in_app","balloon"]'::jsonb, 'persistent',
               '{"requireCurrentDeadlineEvent": false, "excludeCompletedOrders": false}'::jsonb, $2::jsonb, $3, $3)`,
      [ruleCode, JSON.stringify({ userIds: [adminId] }), adminId]);
    const engine = new NotificationRuleEngineService({
      ruleRepo: new PgNotificationRuleRepository(),
      contextBuilder: new PgNotificationContextBuilder(),
      recipientResolver: new RecipientResolverService(new PgRecipientSourceAdapter(), new PgVisibilityAdapter()),
      notificationWrite: new PgNotificationWriteAdapter(),
      channelDelivery: new PgNotificationChannelDeliveryAdapter(),
      runtimeConfig: { isEngineOwnsDeadline: () => true },
    });
    const relay = new OutboxRelayService({
      database,
      outboxRepo: new PgOutboxRepository(),
      consumers: [{ supports: (type) => type === 'deadline.event.created', process: async (client, event) => { await engine.processEvent(client, event); } }],
      config: { workerId: tag, batchSize: 500, maxAttempts: 3 },
    });
    const key = `${tag}:deadline:${randomUUID()}`;
    await conn.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, next_attempt_at)
       VALUES ('deadline.event.created', 'deadline', $1, $2::jsonb, $3, now() - interval '1 second')`,
      [randomUUID(), JSON.stringify({ eventType: 'DEADLINE_EXPIRED', orderId, deadlineEventId: randomUUID() }), key]);
    try {
      const summary = await relay.processBatchOnce();
      expect(summary.failed).toBe(0);
      const rows = (await conn.query(
        `SELECT notification_id, balloon_mode, level FROM notifications WHERE user_id = $1 AND entity_id = $2`, [adminId, String(orderId)])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ balloon_mode: 'persistent', level: 'warning' });
      // Балун не уходит во внешнюю доставку.
      expect(Number((await conn.query('SELECT count(*) AS c FROM notification_channel_deliveries WHERE user_id = $1', [adminId])).rows[0].c)).toBe(0);
      // Вкладка пользователя получает его балуном «не исчезает».
      const claimed = await repoOn(conn).claimBalloonsForUser({ viewer: admin, token: randomUUID(), limit: 5 });
      expect(claimed.map((item) => ({ id: item.notificationId, mode: item.balloonMode, entity: `${item.entityType}:${item.entityId}` })))
        .toEqual([{ id: String(rows[0].notification_id), mode: 'persistent', entity: `order:${orderId}` }]);
    } finally {
      await conn.query('DELETE FROM notifications WHERE user_id = $1', [adminId]);
      await conn.query('DELETE FROM outbox_events WHERE idempotency_key = $1', [key]);
      await conn.query('DELETE FROM notification_rules WHERE rule_code = $1', [ruleCode]);
    }
  });
});
