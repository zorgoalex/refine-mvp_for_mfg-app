import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { OrderTransactionService } from '../application/order-transaction.service';
import { OrderDetailTransferService } from '../application/order-detail-transfer.service';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { PgOrderTransactionManager } from './pg-order-transaction-manager';
import { PgOrderSnapshot } from './pg-order-snapshot';
import type { OrderSnapshotDto } from '../dto/order-snapshot.dto';

const url = process.env.ERP_ORDER_CATALOG_TEST_DATABASE_URL;
class FixtureDatabase extends DatabaseService {
  failCatalogOutbox = false;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    if (this.failCatalogOutbox && sql.includes('INSERT INTO outbox_events') && params[0] === 'order.catalog_lines_changed') await this.client.query('SELECT 1/0');
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('SAVEPOINT order_catalog_command');
    try {
      const result = await fn({ raw: this.client, query: this.query.bind(this) });
      await this.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      await this.client.query('RELEASE SAVEPOINT order_catalog_command');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT order_catalog_command');
      await this.client.query('RELEASE SAVEPOINT order_catalog_command');
      throw error;
    }
  }
}

describe.skipIf(!url)('order catalogue / real PostgreSQL, rollback-only', () => {
  let pool: Pool, client: PoolClient, database: FixtureDatabase, service: OrderTransactionService, actor: CurrentUser, input: SaveOrderDto, prefix: string;
  beforeEach(async () => {
    expect(process.env.ERP_ORDER_CATALOG_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 15000, connectionTimeoutMillis: 5000 });
    client = await pool.connect(); await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='3s'");
    const migration = readFileSync(new URL('../../../../db/migrations/162_order_catalog_lines.sql', import.meta.url), 'utf8');
    await client.query(migration); await client.query(migration);
    prefix = 'E2E-order-catalog-' + randomUUID();
    const actorId = (await client.query(`INSERT INTO users(username,email,password_hash,role_id) VALUES($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id`, [prefix, prefix + '@example.invalid'])).rows[0].user_id;
    actor = { id: String(actorId), username: prefix, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
    const clientId = (await client.query('INSERT INTO clients(client_name) VALUES($1) RETURNING client_id', [prefix])).rows[0].client_id;
    const unitId = (await client.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    const itemId = (await client.query(`INSERT INTO catalog_items(name,kind,unit_id,base_price,created_by,edited_by) VALUES($1,'service',$2,1500.50,$3,$3) RETURNING id`, [prefix, unitId, actor.id])).rows[0].id;
    const statusId = (await client.query('SELECT min(order_status_id) AS id FROM order_statuses WHERE is_active=true')).rows[0].id;
    input = { header: { orderName: prefix, clientId: Number(clientId), orderStatusId: Number(statusId), orderDate: '2026-09-10', discount: 1, surcharge: 0 },
      details: [], catalogLines: [{ clientKey: 'catalog-new', catalogItemId: Number(itemId), catalogVersion: 1, quantity: '2', unitPrice: '1500.50', notes: 'Тест' }],
      payments: [], workshops: [], requirements: [], dowelingLinks: [], deleted: {}, idempotencyKey: randomUUID() };
    database = new FixtureDatabase(client);
    service = new OrderTransactionService({ transactions: new PgOrderTransactionManager(database) });
  });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool?.end(); });

  it('creates goods-only with one audit/outbox, exact totals and idempotent replay', async () => {
    const order = await service.create({ dto: input, currentUser: actor, requestId: prefix });
    expect(order.details).toHaveLength(0); expect(order.catalogLines).toHaveLength(1);
    expect(order.totals).toMatchObject({ totalAmount: 3001, finalAmount: 3000, totalArea: 0, partsCount: 0 });
    expect(await service.create({ dto: input, currentUser: actor, requestId: prefix })).toEqual(order);
    const counts = (await client.query(`SELECT (SELECT count(*)::int FROM audit_log WHERE event='order.catalog_lines_changed' AND request_id=$1) AS audit,
      (SELECT count(*)::int FROM outbox_events WHERE event_type='order.catalog_lines_changed' AND payload_json->>'requestId'=$1) AS outbox`, [prefix])).rows[0];
    expect(counts).toEqual({ audit: 1, outbox: 1 });
  });

  it('preserves omitted rows and archived snapshots, prevents stale save and removal of final position', async () => {
    const first = await service.create({ dto: input, currentUser: actor, requestId: prefix });
    const id = first.header.orderId;
    await client.query("UPDATE catalog_items SET name='changed',base_price=42,is_active=false,version=version+1 WHERE id=$1", [input.catalogLines![0].catalogItemId]);
    const dto: SaveOrderDto = { ...input, catalogLines: undefined, idempotencyKey: undefined, version: first.version };
    const second = await service.update({ orderId: id, dto, currentUser: actor, requestId: prefix });
    expect(second.catalogLines![0]).toMatchObject({ name: prefix, unitPrice: '1500.50', catalogActive: false });
    expect(second.totals.totalAmount).toBe(3001);
    await expect(service.update({ orderId: id, dto, currentUser: actor })).rejects.toMatchObject({ code: 'ORDER_VERSION_CONFLICT' });
    await expect(service.update({ orderId: id, dto: { ...dto, header: { ...dto.header, discount: 0 }, version: second.version, deleted: { catalogLineIds: [second.catalogLines![0].id] } }, currentUser: actor }))
      .rejects.toMatchObject({ code: 'ORDER_POSITIONS_REQUIRED' });
    expect((await client.query('SELECT count(*)::int AS n FROM order_catalog_lines WHERE order_id=$1 AND delete_flag=false', [id])).rows[0].n).toBe(1);
    await expect(service.create({ dto: { ...input, idempotencyKey: randomUUID(), header: { ...input.header, orderName: prefix + '-2' } }, currentUser: actor }))
      .rejects.toMatchObject({ code: 'ORDER_CATALOG_CHANGED' });
  });

  it('rolls back all new data when durable catalogue event fails', async () => {
    database.failCatalogOutbox = true;
    await expect(service.create({ dto: input, currentUser: actor, requestId: prefix })).rejects.toMatchObject({ code: '22012' });
    expect((await client.query('SELECT count(*)::int AS n FROM orders WHERE order_name=$1', [prefix])).rows[0].n).toBe(0);
    expect((await client.query('SELECT count(*)::int AS n FROM order_catalog_lines WHERE created_by=$1', [actor.id])).rows[0].n).toBe(0);
  });

  it('round-trips goods-only JSON snapshots with price/type/1C snapshots and idempotent replay', async () => {
    const first = await service.create({ dto: input, currentUser: actor, requestId: prefix });
    const adapter = new PgOrderSnapshot(database);
    const exported = await adapter.exportOrderSnapshot({ orderId: first.header.orderId, currentUser: actor, requestId: prefix });
    const snapshot: OrderSnapshotDto = JSON.parse(exported.content);
    expect(snapshot.data.catalogLines).toEqual([expect.objectContaining({ name: prefix, kind: 'service', quantity: '2.000', unitPrice: '1500.50', amount: '3001.00' })]);
    snapshot.data.order.orderName = prefix + '-import';
    snapshot.identity.order.refKey1c = null; snapshot.data.order.refKey1c = null;
    snapshot.source.payloadHash = '';
    const imported = await adapter.importOrderSnapshot({ snapshot, currentUser: actor, requestId: prefix });
    expect(imported.status).toBe('created');
    const copy = JSON.parse((await adapter.exportOrderSnapshot({ orderId: imported.orderId, currentUser: actor })).content) as OrderSnapshotDto;
    expect(copy.data.catalogLines![0]).toMatchObject({ name: prefix, kind: 'service', quantity: '2.000', unitPrice: '1500.50', amount: '3001.00' });
    expect((await client.query('SELECT total_amount,final_amount,parts_count FROM orders WHERE order_id=$1', [imported.orderId])).rows[0]).toMatchObject({ total_amount: '3001.00', final_amount: '3000.00', parts_count: 0 });
    expect((await adapter.importOrderSnapshot({ snapshot, currentUser: actor, requestId: prefix })).status).toBe('noop');
  });

  it('edits price/quantity/note and explicitly deletes a row, rejects foreign row IDs', async () => {
    const first = await service.create({ dto: { ...input, catalogLines: [...input.catalogLines!, { ...input.catalogLines![0], clientKey: 'second' }] }, currentUser: actor });
    const foreign = await service.create({ dto: { ...input, idempotencyKey: randomUUID(), header: { ...input.header, orderName: prefix + '-foreign' } }, currentUser: actor });
    const dto = { ...input, version: first.version, idempotencyKey: undefined, catalogLines: [{ ...input.catalogLines![0], id: foreign.catalogLines![0].id }] };
    await expect(service.update({ orderId: first.header.orderId, dto, currentUser: actor })).rejects.toMatchObject({ code: 'ORDER_CATALOG_LINE_OWNERSHIP' });
    const updated = await service.update({ orderId: first.header.orderId, dto: { ...dto,
      catalogLines: [{ ...input.catalogLines![0], id: first.catalogLines![0].id, quantity: '1.125', unitPrice: '10.01', notes: 'edited' }],
      deleted: { catalogLineIds: [first.catalogLines![1].id] } }, currentUser: actor });
    expect(updated.catalogLines).toHaveLength(1);
    expect(updated.catalogLines![0]).toMatchObject({ quantity: '1.125', unitPrice: '10.01', amount: '11.26', notes: 'edited' });
    expect(updated.totals.finalAmount).toBe(10.26);
    await expect(database.transaction(tx => tx.query('DELETE FROM order_catalog_lines WHERE order_id=$1', [first.header.orderId])))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('keeps mixed totals and permits removal of final detail while catalogue remains', async () => {
    const refs = (await client.query('SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling,(SELECT min(edge_type_id) FROM edge_types) AS edge,(SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet')).rows[0];
    const detail = { clientKey: 'detail', detailNumber: 1, height: 500, width: 300, quantity: 1, area: 0.15,
      millingTypeId: Number(refs.milling), edgeTypeId: Number(refs.edge), sheetMaterialTypeId: Number(refs.sheet), materialId: null,
      millingCostPerSqm: 100, detailCost: 100 };
    const first = await service.create({ dto: { ...input, details: [detail] }, currentUser: actor });
    expect(first.totals).toMatchObject({ totalAmount: 3101, finalAmount: 3100, partsCount: 1 });
    const goodsOnly = await service.update({ orderId: first.header.orderId, currentUser: actor,
      dto: { ...input, version: first.version, idempotencyKey: undefined, catalogLines: undefined, details: [], deleted: { detailIds: [first.details[0].id!] } } });
    expect(goodsOnly.totals).toMatchObject({ totalAmount: 3001, partsCount: 0 });
    const detailsOnly = await service.update({ orderId: first.header.orderId, currentUser: actor,
      dto: { ...input, version: goodsOnly.version, idempotencyKey: undefined, catalogLines: [], details: [{ ...detail, clientKey: 'new-detail' }], deleted: { catalogLineIds: [goodsOnly.catalogLines![0].id] } } });
    expect(detailsOnly.catalogLines).toHaveLength(0);
    expect(detailsOnly.totals).toMatchObject({ totalAmount: 100, finalAmount: 99, partsCount: 1 });
  });

  it('preserves sale lines through parent delete and restore', async () => {
    const first = await service.create({ dto: input, currentUser: actor });
    await service.delete({ orderId: first.header.orderId, version: first.version, idempotencyKey: randomUUID(), currentUser: actor });
    const version = (await client.query('SELECT version FROM orders WHERE order_id=$1', [first.header.orderId])).rows[0].version;
    const restored = await service.restore({ orderId: first.header.orderId, version, idempotencyKey: randomUUID(), currentUser: actor });
    expect(restored.order.catalogLines).toEqual(first.catalogLines);
    expect(restored.order.totals.totalAmount).toBe(3001);
  });

  it('transfers the final manufacturing detail while keeping each order catalogue subtotal', async () => {
    const refs = (await client.query('SELECT (SELECT min(milling_type_id) FROM milling_types) AS milling,(SELECT min(edge_type_id) FROM edge_types) AS edge,(SELECT min(sheet_material_type_id) FROM sheet_material_types) AS sheet')).rows[0];
    const source = await service.create({ dto: { ...input, details: [{ clientKey: 'move', detailNumber: 1, height: 500, width: 300, quantity: 1, area: 0.15,
      millingTypeId: Number(refs.milling), edgeTypeId: Number(refs.edge), sheetMaterialTypeId: Number(refs.sheet), materialId: null, detailCost: 100 }] }, currentUser: actor });
    const target = await service.create({ dto: { ...input, idempotencyKey: randomUUID(), header: { ...input.header, orderName: prefix + '-target', discount: 0 } }, currentUser: actor });
    const transfer = new OrderDetailTransferService({ database, sheetOrdersReads: true });
    const moved = await transfer.transfer({ currentUser: actor, sourceOrderId: source.header.orderId, sourceVersion: source.version, idempotencyKey: randomUUID(),
      dto: { detailIds: [source.details[0].id!], target: { mode: 'existing', orderId: target.header.orderId, version: target.version } } });
    expect(moved.sourceOrder.catalogLines).toEqual(source.catalogLines);
    expect(moved.targetOrder.catalogLines).toEqual(target.catalogLines);
    expect(moved.sourceOrder.totals).toMatchObject({ totalAmount: 3001, partsCount: 0 });
    expect(moved.targetOrder.totals).toMatchObject({ totalAmount: 3101, partsCount: 1 });
  });
});
