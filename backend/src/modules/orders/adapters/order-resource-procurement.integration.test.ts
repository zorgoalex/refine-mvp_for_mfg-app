import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceDemandLineDto } from '../application/order-resource-demand.types';
import { PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';
import { PgOrderResourceProcurementRepository } from './pg-order-resource-procurement-repository';

// Separate-connection races need COMMITTED fixtures. This suite runs ONLY against an
// owned disposable database: the URL must opt in via ERP_PROCUREMENT_RACE_DATABASE_URL,
// the database name must start with "procurement_race_", and the runner drops it afterwards.
// Nothing here may ever point at the shared stage database.
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;

function assertRaceTarget(): void {
  expect(targetEnv).toBe('backend-test');
  const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
  if (!dbName.startsWith('procurement_race_')) {
    throw new Error(`ERP_PROCUREMENT_RACE_DATABASE_URL must point at an owned "procurement_race_*" database (got "${dbName}")`);
  }
}

/** Real BEGIN/COMMIT per transaction on the caller's connection. */
class CommittedDatabase extends DatabaseService {
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 15000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL lock_timeout='10s'");
    try {
      const result = await handler(this.tx);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

describe.skipIf(!url)('order resource procurement — real PostgreSQL, committed fixtures', { timeout: 30000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let commandsA: PgOrderResourceProcurementRepository;
  let commandsB: PgOrderResourceProcurementRepository;
  let readsA: PgOrderResourceDemandRepository;
  const tag = 'E2E-Тест-закуп-' + randomUUID().slice(0, 8);
  let admin: CurrentUser;
  let manager: CurrentUser;
  let orderIds: number[] = [];
  let sheetMaterialTypeId: number;
  let filmId: number;
  let detailIds: number[] = [];

  const sheetKey = () => `sheet_material:${sheetMaterialTypeId}`;
  const filmKey = () => `film:${filmId}`;

  async function line(orderId: number, key: string, user: CurrentUser = admin): Promise<OrderResourceDemandLineDto> {
    const card = await readsA.getCard({ currentUser: user, orderId }, { procurementEnabled: true });
    const found = card.data.lines.find((candidate) => candidate.resourceKey === key);
    if (!found) throw new Error(`line ${key} not found in order ${orderId}`);
    return found;
  }

  async function counts(orderId: number) {
    const audit = await connA.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE related_order_id = $1 AND event LIKE 'order_resource.procurement_%' AND event <> 'order_resource.procurement_denied'`,
      [orderId],
    );
    const outbox = await connA.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_events
        WHERE event_type = 'order.resource_procurement_changed' AND aggregate_id = $1`,
      [String(orderId)],
    );
    return { audit: audit.rows[0].count, outbox: outbox.rows[0].count };
  }

  beforeAll(async () => {
    assertRaceTarget();
    pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    connA = await pool.connect();
    connB = await pool.connect();
    commandsA = new PgOrderResourceProcurementRepository(new CommittedDatabase(connA));
    commandsB = new PgOrderResourceProcurementRepository(new CommittedDatabase(connB));
    readsA = new PgOrderResourceDemandRepository(new CommittedDatabase(connA));

    const adminId = Number((await connA.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [tag + '-admin', tag + '-admin@example.invalid'],
    )).rows[0].user_id);
    const managerId = Number((await connA.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 10) RETURNING user_id`,
      [tag + '-manager', tag + '-manager@example.invalid'],
    )).rows[0].user_id);
    for (const conn of [connA, connB]) {
      await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
      await conn.query('SELECT set_config($1, $2, false)', [
        'hasura.user',
        JSON.stringify({ 'x-hasura-user-id': String(adminId), 'x-hasura-role': 'admin' }),
      ]);
    }
    admin = { id: String(adminId), username: tag + '-admin', role: 'admin', roleId: 1, permissions: ['orders.view', 'procurement.manage'] };
    manager = { id: String(managerId), username: tag + '-manager', role: 'manager', roleId: 10, permissions: ['orders.view', 'procurement.manage'] };

    sheetMaterialTypeId = Number((await connA.query('SELECT sheet_material_type_id FROM sheet_material_types ORDER BY sheet_material_type_id LIMIT 1')).rows[0].sheet_material_type_id);
    filmId = Number((await connA.query('SELECT film_id FROM films ORDER BY film_id LIMIT 1')).rows[0].film_id);
    const millingTypeId = Number((await connA.query('SELECT milling_type_id FROM milling_types ORDER BY milling_type_id LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await connA.query('SELECT edge_type_id FROM edge_types ORDER BY edge_type_id LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await connA.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    const projectId = Number((await connA.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId],
    )).rows[0].project_id);

    orderIds = [];
    detailIds = [];
    for (let index = 0; index < 3; index += 1) {
      // A production order must own an active detail at commit time (deferred check).
      await connA.query('BEGIN');
      const orderId = Number((await connA.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by)
         VALUES ($1, $2, $3, 1, 1, $4) RETURNING order_id`,
        [`${tag}-${index}`, clientId, projectId, adminId],
      )).rows[0].order_id);
      orderIds.push(orderId);
      const detailId = Number((await connA.query(
        `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area,
            sheet_material_type_id, film_id, milling_type_id, edge_type_id, created_by)
         VALUES ($1, 1, 716, 396, 2, 0.57, $2, $3, $4, $5, $6) RETURNING detail_id`,
        [orderId, sheetMaterialTypeId, filmId, millingTypeId, edgeTypeId, adminId],
      )).rows[0].detail_id);
      detailIds.push(detailId);
      await connA.query('COMMIT');
    }
  }, 30000);

  afterAll(async () => {
    try { connA?.release(); } catch { /* released */ }
    try { connB?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('marks a material once: row, snapshot, one audit row and one outbox event keyed by order', async () => {
    const orderId = orderIds[0];
    const before = await line(orderId, sheetKey());
    expect(before.procurement).toMatchObject({ purchased: false, version: 0 });
    const requestId = `${tag}-mark`;

    const result = await commandsA.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: 0, expectedDemandFingerprint: before.demandFingerprint, requestId,
    });
    expect(result.changed).toBe(true);
    expect(result.line.procurement).toMatchObject({ purchased: true, version: 1, origin: 'manual', changedSinceMark: false });
    expect(result.line.procurement.markedBy?.userId).toBe(Number(admin.id));

    const row = (await connA.query(
      `SELECT purchased, version, unit_at_mark, demand_fingerprint_at_mark FROM order_resource_procurement
        WHERE order_id = $1 AND resource_kind = 'sheet_material'`, [orderId])).rows[0];
    expect(row).toMatchObject({ purchased: true, version: 1, unit_at_mark: 'm2', demand_fingerprint_at_mark: before.demandFingerprint });
    const audit = (await connA.query(
      `SELECT event, entity_type, related_order_id, request_id FROM audit_log
        WHERE related_order_id = $1 AND request_id = $2`, [orderId, requestId])).rows;
    expect(audit).toEqual([expect.objectContaining({
      event: 'order_resource.procurement_marked', entity_type: 'order_resource_procurement', related_order_id: String(orderId),
    })]);
    const outbox = (await connA.query(
      `SELECT idempotency_key, payload_json FROM outbox_events WHERE payload_json->>'requestId' = $1`, [requestId])).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].idempotency_key).toBe(`order_resource_procurement:${orderId}:${sheetKey()}:1`);
    expect(outbox[0].payload_json).toMatchObject({ changeType: 'marked', orderId, purchased: true, version: 1 });
  });

  it('treats a retry after a lost response as a no-op: no second audit row or event', async () => {
    const orderId = orderIds[0];
    const beforeCounts = await counts(orderId);
    const current = await line(orderId, sheetKey());
    const retry = await commandsA.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: 0, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-retry`,
    });
    expect(retry.changed).toBe(false);
    expect(retry.line.procurement.version).toBe(1);
    expect(await counts(orderId)).toEqual(beforeCounts);
  });

  it('rejects a stale command that really changes state (documented version sequence)', async () => {
    const orderId = orderIds[0];
    const fp = (await line(orderId, sheetKey())).demandFingerprint;
    // true/v1 → B(false, expected=1) → false/v2 → A(true, expected=2) → true/v3
    await commandsB.set({ currentUser: admin, orderId, resourceKey: sheetKey(), purchased: false, expectedVersion: 1, expectedDemandFingerprint: fp, requestId: `${tag}-b1` });
    await commandsA.set({ currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true, expectedVersion: 2, expectedDemandFingerprint: fp, requestId: `${tag}-a2` });
    const beforeCounts = await counts(orderId);
    await expect(commandsB.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: false,
      expectedVersion: 1, expectedDemandFingerprint: fp, requestId: `${tag}-b-stale`,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_VERSION_CONFLICT' });
    expect((await line(orderId, sheetKey())).procurement).toMatchObject({ purchased: true, version: 3 });
    expect(await counts(orderId)).toEqual(beforeCounts);
  });

  it('refuses a mark when the demand changed after it was read, and flags changedSinceMark for old marks', async () => {
    const orderId = orderIds[1];
    const seen = await line(orderId, sheetKey());
    await connA.query('UPDATE order_details SET height = height + 100, updated_at = now() WHERE detail_id = $1', [detailIds[1]]);
    await expect(commandsA.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: 0, expectedDemandFingerprint: seen.demandFingerprint, requestId: `${tag}-stale-demand`,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_DEMAND_CHANGED' });

    const fresh = await line(orderId, sheetKey());
    await commandsA.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: 0, expectedDemandFingerprint: fresh.demandFingerprint, requestId: `${tag}-fresh-demand`,
    });
    await connA.query('UPDATE order_details SET quantity = quantity + 1, updated_at = now() WHERE detail_id = $1', [detailIds[1]]);
    expect((await line(orderId, sheetKey())).procurement).toMatchObject({ purchased: true, changedSinceMark: true });
  });

  it('hides orders outside the user scope: 404 for single and bulk, nothing written', async () => {
    // manager scope is "own": orders created by admin are invisible to this manager.
    const orderId = orderIds[2];
    const fp = (await line(orderId, filmKey())).demandFingerprint;
    await expect(commandsA.set({
      currentUser: manager, orderId, resourceKey: filmKey(), purchased: true,
      expectedVersion: 0, expectedDemandFingerprint: fp, requestId: `${tag}-scope`,
    })).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });
    await expect(readsA.getCard({ currentUser: manager, orderId }, { procurementEnabled: true }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(commandsA.bulk({
      currentUser: manager, resourceKey: filmKey(), purchased: true, requestId: `${tag}-scope-bulk`,
      items: [{ orderId, expectedVersion: 0, expectedDemandFingerprint: fp }],
    })).rejects.toMatchObject({ statusCode: 404 });
    const rows = await connA.query('SELECT 1 FROM order_resource_procurement WHERE order_id = $1 AND resource_kind = $2', [orderId, 'film']);
    expect(rows.rows).toHaveLength(0);
  });

  it('bulk is all-or-nothing and writes one audit row and one event per order under one requestId', async () => {
    const items = await Promise.all(orderIds.map(async (orderId) => {
      const current = await line(orderId, filmKey());
      return { orderId, expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint };
    }));
    const stale = items.map((item, index) => (index === 1 ? { ...item, expectedDemandFingerprint: 'f'.repeat(64) } : item));
    await expect(commandsA.bulk({ currentUser: admin, resourceKey: filmKey(), purchased: true, requestId: `${tag}-bulk-stale`, items: stale }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_BULK_CONFLICT' });
    expect((await connA.query("SELECT count(*)::int AS c FROM order_resource_procurement WHERE resource_kind = 'film' AND order_id = ANY($1)", [orderIds])).rows[0].c).toBe(0);

    const requestId = `${tag}-bulk`;
    const result = await commandsA.bulk({ currentUser: admin, resourceKey: filmKey(), purchased: true, requestId, items });
    expect(result.results.map((row) => row.changed)).toEqual([true, true, true]);
    const outbox = (await connA.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM outbox_events WHERE payload_json->>'requestId' = $1 ORDER BY idempotency_key`, [requestId])).rows;
    expect(new Set(outbox.map((row) => row.idempotency_key)).size).toBe(3);
    for (const orderId of orderIds) expect(outbox.some((row) => row.idempotency_key.includes(`:${orderId}:`))).toBe(true);
    const audit = (await connA.query<{ c: number }>(`SELECT count(*)::int AS c FROM audit_log WHERE request_id = $1`, [requestId])).rows[0].c;
    expect(audit).toBe(3);
  });

  it('keeps a purchased mark for a material no longer needed as an orphan line that can be unmarked', async () => {
    const orderId = orderIds[2];
    await connA.query('UPDATE order_details SET film_id = NULL, updated_at = now() WHERE detail_id = $1', [detailIds[2]]);
    const orphan = await line(orderId, filmKey());
    expect(orphan).toMatchObject({ orphan: true, quantity: 0, procurement: { purchased: true } });
    const card = await readsA.getCard({ currentUser: admin, orderId }, { procurementEnabled: true });
    expect(card.data.procurementSummary.orphanPurchased).toBe(1);
    const cleared = await commandsA.set({
      currentUser: admin, orderId, resourceKey: filmKey(), purchased: false,
      expectedVersion: orphan.procurement.version, expectedDemandFingerprint: orphan.demandFingerprint, requestId: `${tag}-orphan`,
    });
    expect(cleared.changed).toBe(true);
    expect(cleared.line).toMatchObject({ orphan: true, procurement: { purchased: false } });
    const repeated = await commandsA.set({
      currentUser: admin, orderId, resourceKey: filmKey(), purchased: false,
      expectedVersion: orphan.procurement.version, expectedDemandFingerprint: orphan.demandFingerprint, requestId: `${tag}-orphan-retry`,
    });
    expect(repeated.changed).toBe(false);
    await expect(commandsA.set({
      currentUser: admin, orderId, resourceKey: filmKey(), purchased: true,
      expectedVersion: cleared.line.procurement.version, expectedDemandFingerprint: orphan.demandFingerprint, requestId: `${tag}-orphan-mark`,
    })).rejects.toMatchObject({ statusCode: 422, code: 'PROCUREMENT_RESOURCE_NOT_IN_ORDER' });
  });

  it('two connections marking the same material concurrently: one change, one no-op, one event', async () => {
    const orderId = orderIds[1];
    const current = await line(orderId, filmKey());
    // Unmark first so both racers start from the same visible state.
    await commandsA.set({ currentUser: admin, orderId, resourceKey: filmKey(), purchased: false, expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-race-reset` });
    const start = await line(orderId, filmKey());
    const beforeCounts = await counts(orderId);
    const command = (repo: PgOrderResourceProcurementRepository, suffix: string) => repo.set({
      currentUser: admin, orderId, resourceKey: filmKey(), purchased: true,
      expectedVersion: start.procurement.version, expectedDemandFingerprint: start.demandFingerprint, requestId: `${tag}-race-${suffix}`,
    });
    const [left, right] = await Promise.all([command(commandsA, 'a'), command(commandsB, 'b')]);
    expect([left.changed, right.changed].sort()).toEqual([false, true]);
    const afterCounts = await counts(orderId);
    expect(afterCounts.audit - beforeCounts.audit).toBe(1);
    expect(afterCounts.outbox - beforeCounts.outbox).toBe(1);
  });

  async function backendPid(conn: PoolClient): Promise<number> {
    return Number((await conn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  }

  /**
   * Ждёт, пока все указанные соединения встанут в очередь блокировок, пока holder
   * держит заказ. Вторая команда может ждать первую, а не holder напрямую.
   */
  async function waitBlockedBy(holderPid: number, waiterPids: number[]): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const blocked = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0
            AND EXISTS (SELECT 1 FROM pg_stat_activity h WHERE h.pid = $2::int AND h.state = 'idle in transaction')`,
        [waiterPids, holderPid],
      );
      if (blocked.rows.length === waiterPids.length) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('commands did not queue behind the held order lock');
  }

  it('bulk and a single command on the same order queue behind the order lock and resolve exactly once', async () => {
    const [first, second] = orderIds;
    const snapshot = await Promise.all([first, second].map(async (orderId) => {
      const current = await line(orderId, sheetKey());
      return { orderId, version: current.procurement.version, fingerprint: current.demandFingerprint, purchased: current.procurement.purchased };
    }));
    // Выравниваем оба заказа к одному исходному состоянию «не закуплено».
    for (const row of snapshot.filter((candidate) => candidate.purchased)) {
      await commandsA.set({ currentUser: admin, orderId: row.orderId, resourceKey: sheetKey(), purchased: false, expectedVersion: row.version, expectedDemandFingerprint: row.fingerprint, requestId: `${tag}-queue-reset-${row.orderId}` });
    }
    const start = await Promise.all([first, second].map(async (orderId) => {
      const current = await line(orderId, sheetKey());
      return { orderId, expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint };
    }));
    const beforeSecond = await counts(second);

    const holder = await pool.connect();
    try {
      const holderPid = await backendPid(holder);
      const [pidA, pidB] = await Promise.all([backendPid(connA), backendPid(connB)]);
      await holder.query('BEGIN');
      await holder.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [second]);
      const bulk = commandsA.bulk({ currentUser: admin, resourceKey: sheetKey(), purchased: true, requestId: `${tag}-queue-bulk`, items: start });
      const single = commandsB.set({
        currentUser: admin, orderId: second, resourceKey: sheetKey(), purchased: true,
        expectedVersion: start[1].expectedVersion, expectedDemandFingerprint: start[1].expectedDemandFingerprint, requestId: `${tag}-queue-single`,
      });
      await waitBlockedBy(holderPid, [pidA, pidB]);
      await holder.query('COMMIT');
      const [bulkResult, singleResult] = await Promise.all([bulk, single]);
      const secondChanges = [
        bulkResult.results.find((row) => row.orderId === second)!.changed,
        singleResult.changed,
      ];
      expect(secondChanges.filter(Boolean)).toHaveLength(1);
      expect(bulkResult.results.find((row) => row.orderId === first)!.changed).toBe(true);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await line(second, sheetKey())).procurement).toMatchObject({ purchased: true, version: start[1].expectedVersion + 1 });
    const afterSecond = await counts(second);
    expect(afterSecond.audit - beforeSecond.audit).toBe(1);
    expect(afterSecond.outbox - beforeSecond.outbox).toBe(1);
  });

  it('an order save that changes a detail while bulk waits makes bulk fail with DEMAND_CHANGED and write nothing', async () => {
    const orderId = orderIds[0];
    const current = await line(orderId, sheetKey());
    const reset = await commandsA.set({ currentUser: admin, orderId, resourceKey: sheetKey(), purchased: false, expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-save-reset` });
    const seen = reset.line;
    const beforeCounts = await counts(orderId);
    const holder = await pool.connect();
    try {
      const holderPid = await backendPid(holder);
      const pidA = await backendPid(connA);
      await holder.query('BEGIN');
      // Сохранение заказа: сначала заказ, затем его деталь (production lock order).
      await holder.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      await holder.query('UPDATE order_details SET width = width + 50, updated_at = now() WHERE detail_id = $1', [detailIds[0]]);
      const bulk = commandsA.bulk({
        currentUser: admin, resourceKey: sheetKey(), purchased: true, requestId: `${tag}-save-bulk`,
        items: [{ orderId, expectedVersion: seen.procurement.version, expectedDemandFingerprint: seen.demandFingerprint }],
      });
      const outcome = bulk.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      await waitBlockedBy(holderPid, [pidA]);
      await holder.query('COMMIT');
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('bulk must fail');
      expect(result.error).toMatchObject({ statusCode: 409, code: 'PROCUREMENT_BULK_CONFLICT' });
      expect((result.error as { details?: { conflicts?: Array<{ code: string }> } }).details?.conflicts?.[0]?.code)
        .toBe('PROCUREMENT_DEMAND_CHANGED');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await counts(orderId)).toEqual(beforeCounts);
    expect((await line(orderId, sheetKey())).procurement.purchased).toBe(false);
  });

  it('a new HDF position for the same material changes the demand fingerprint and blocks a stale mark', async () => {
    const orderId = orderIds[0];
    const seen = await line(orderId, sheetKey());
    const revision = Number((await connA.query('SELECT revision FROM hdf_calculation_config_state WHERE id = 1')).rows[0].revision);
    await connA.query(
      `INSERT INTO order_hdf_details (order_id, source_order_detail_id_snapshot, source_detail_number, source_detail_name,
          hdf_sheet_material_type_id, hdf_height_mm, hdf_width_mm, quantity, status, source_snapshot_hash, source_snapshot_json, config_revision)
       VALUES ($1, $2, 1, $3, $4, 700, 380, 2, 'ok', 'e2e-hash', '{}'::jsonb, $5)`,
      [orderId, detailIds[0], `${tag}-hdf`, sheetMaterialTypeId, revision],
    );
    const fresh = await line(orderId, sheetKey());
    expect(fresh.demandFingerprint).not.toBe(seen.demandFingerprint);
    const card = await readsA.getCard({ currentUser: admin, orderId }, { procurementEnabled: true });
    expect(card.data.lines.find((row) => row.resourceKey === sheetKey())?.details.some((ref) => ref.source === 'hdf')).toBe(true);
    await expect(commandsA.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: seen.procurement.version, expectedDemandFingerprint: seen.demandFingerprint, requestId: `${tag}-hdf-stale`,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_DEMAND_CHANGED' });
  });

  it('lists orders with unpurchased materials only while something is left unpurchased', async () => {
    const query = { page: 1, pageSize: 100, search: tag, unpurchasedOnly: true };
    const listed = await readsA.list({ currentUser: admin, query }, { procurementEnabled: true });
    const ids = new Set(listed.data.map((row) => row.orderId));
    for (const order of listed.data) {
      expect(order.lines.some((candidate) => !candidate.orphan && !candidate.procurement.purchased)).toBe(true);
    }
    const all = await readsA.list({ currentUser: admin, query: { page: 1, pageSize: 100, search: tag } }, { procurementEnabled: true });
    for (const order of all.data) {
      const hasUnpurchased = order.lines.some((candidate) => !candidate.orphan && !candidate.procurement.purchased);
      expect(ids.has(order.orderId)).toBe(hasUnpurchased);
    }
    expect(all.capabilities).toEqual({ procurement: true, byMaterial: true, cardDetails: true, onecDocuments: true });
  });

  it('aggregates by material across the filtered orders with per-order participants', async () => {
    const result = await readsA.listByMaterial({ currentUser: admin, query: { page: 1, pageSize: 20, search: tag } }, { procurementEnabled: true });
    const sheet = result.data.find((row) => row.resourceKey === sheetKey());
    expect(sheet?.ordersCount).toBe(3);
    expect(sheet?.participants.map((row) => row.orderId).sort()).toEqual([...orderIds].sort());
    const card = await readsA.getCard({ currentUser: admin, orderId: orderIds[0] }, { procurementEnabled: true });
    expect(card.data.lines.find((row) => row.resourceKey === sheetKey())?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'detail', id: detailIds[0], detailNumber: 1, quantity: 2 }),
    ]));
  });

  it('with the procurement flag off never reads the procurement table', async () => {
    const result = await readsA.list({ currentUser: admin, query: { page: 1, pageSize: 20, search: tag } }, { procurementEnabled: false });
    expect(result.capabilities.procurement).toBe(false);
    for (const order of result.data) {
      for (const candidate of order.lines) expect(candidate.procurement).toMatchObject({ purchased: false, version: 0 });
    }
  });
});
