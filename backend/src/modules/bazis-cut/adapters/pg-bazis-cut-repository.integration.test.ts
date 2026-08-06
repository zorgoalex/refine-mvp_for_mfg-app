import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { BazisCutDetailFields } from '../dto/bazis-cut.dto';
import { PgBazisCutRepository } from './pg-bazis-cut-repository';

const databaseUrl = process.env.BAZIS_CUT_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PgBazisCutRepository real PostgreSQL transaction harness', () => {
  let pool: Pool;
  let database: DatabaseService;
  let user: CurrentUser;
  const ownedSetIds: number[] = [];
  const keyPrefix = `bazis-cut-it-${randomUUID()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    database = databaseFromPool(pool);
    const actor = await pool.query<{ user_id: string; username: string }>(
      `SELECT user_id::text, username FROM users ORDER BY user_id LIMIT 1`,
    );
    if (!actor.rows[0]) throw new Error('Integration DB requires at least one user');
    user = { id: actor.rows[0].user_id, username: actor.rows[0].username,
      role: 'admin', roleId: 1, permissions: ['cut.view', 'cut.manage', 'orders.view'] };
  });

  afterAll(async () => {
    if (!pool) return;
    for (const setId of ownedSetIds) {
      await pool.query(`DELETE FROM audit_log WHERE entity_type='bazis_cut_set' AND entity_id=$1`, [String(setId)]);
      await pool.query(`DELETE FROM outbox_events WHERE aggregate_type='bazis_cut_set' AND aggregate_id=$1`, [String(setId)]);
      await pool.query(`DELETE FROM bazis_cut_sets WHERE bazis_cut_set_id=$1`, [setId]);
    }
    await pool.query(`DELETE FROM command_idempotency_keys WHERE idempotency_key LIKE $1`, [`${keyPrefix}%`]);
    await pool.end();
  });

  it('updates, exports and removes a persisted typed snapshot with atomic audit/outbox', async () => {
    const header = await pool.query<{ bazis_cut_set_id: string }>(
      `INSERT INTO bazis_cut_sets(name,created_by,updated_by) VALUES($1,$2,$2) RETURNING bazis_cut_set_id::text`,
      [`IT ${keyPrefix}`, Number(user.id)],
    );
    const setId = Number(header.rows[0].bazis_cut_set_id); ownedSetIds.push(setId);
    const inserted = await pool.query<{ bazis_cut_set_detail_id: string }>(
      `INSERT INTO bazis_cut_set_details
       (bazis_cut_set_id,sort_order,material_name,thickness_mm,position,part_name,
        finished_length_mm,finished_width_mm,cut_length_mm,cut_width_mm,quantity,created_by,updated_by)
       VALUES($1,0,'МДФ 16 мм',16,'001','Фасад',1000,500,1000,500,2,$2,$2)
       RETURNING bazis_cut_set_detail_id::text`, [setId, Number(user.id)],
    );
    const detailId = Number(inserted.rows[0].bazis_cut_set_detail_id);
    const repository = new PgBazisCutRepository(database);

    const updated = await repository.updateDetail({ currentUser: user, requestId: `${keyPrefix}-update`,
      idempotencyKey: `${keyPrefix}-update`, setId, detailId, expectedVersion: 0,
      fields: fields({ route: 'Присадка:', cutWidthMm: 499.9 }) });
    expect(updated.set.version).toBe(1);
    expect(updated.set.details[0].route).toBe('Присадка:');

    const replay = await repository.updateDetail({ currentUser: user, requestId: `${keyPrefix}-update`,
      idempotencyKey: `${keyPrefix}-update`, setId, detailId, expectedVersion: 0,
      fields: fields({ route: 'Присадка:', cutWidthMm: 499.9 }) });
    expect(replay).toEqual(updated);
    await expect(repository.updateDetail({ currentUser: user, requestId: `${keyPrefix}-stale`,
      idempotencyKey: `${keyPrefix}-stale`, setId, detailId, expectedVersion: 0,
      fields: fields({ route: 'stale' }) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BAZIS_CUT_SET_STALE_VERSION' });

    const auditBeforeNoop = await count(pool, `SELECT COUNT(*)::integer AS count FROM audit_log
      WHERE entity_type='bazis_cut_set' AND entity_id=$1`, [String(setId)]);
    const outboxBeforeNoop = await count(pool, `SELECT COUNT(*)::integer AS count FROM outbox_events
      WHERE aggregate_type='bazis_cut_set' AND aggregate_id=$1`, [String(setId)]);
    const noop = await repository.updateDetail({ currentUser: user, requestId: `${keyPrefix}-noop`,
      idempotencyKey: `${keyPrefix}-noop`, setId, detailId, expectedVersion: 1,
      fields: fields({ route: 'Присадка:', cutWidthMm: 499.9 }) });
    expect(noop.set.version).toBe(1);
    expect(await count(pool, `SELECT COUNT(*)::integer AS count FROM audit_log
      WHERE entity_type='bazis_cut_set' AND entity_id=$1`, [String(setId)])).toBe(auditBeforeNoop);
    expect(await count(pool, `SELECT COUNT(*)::integer AS count FROM outbox_events
      WHERE aggregate_type='bazis_cut_set' AND aggregate_id=$1`, [String(setId)])).toBe(outboxBeforeNoop);

    const exported = await repository.export({ currentUser: user, requestId: `${keyPrefix}-export`, setId });
    expect(exported.bytes.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');

    const removed = await repository.deleteDetail({ currentUser: user, requestId: `${keyPrefix}-remove`,
      idempotencyKey: `${keyPrefix}-remove`, setId, detailId, expectedVersion: 1 });
    expect(removed.set.positionCount).toBe(0);
    const events = await pool.query<{ event: string }>(
      `SELECT event FROM audit_log WHERE entity_type='bazis_cut_set' AND entity_id=$1`, [String(setId)],
    );
    expect(events.rows.map((row) => row.event)).toEqual(expect.arrayContaining([
      'bazis_cut_set.detail_updated', 'bazis_cut_set.exported', 'bazis_cut_set.detail_removed',
    ]));
    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE aggregate_type='bazis_cut_set' AND aggregate_id=$1`, [String(setId)],
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'bazis_cut_set.detail_updated', 'bazis_cut_set.detail_removed',
    ]));
  });

  it('creates snapshots with Basis project/order parity and the linked node designation', async () => {
    const candidates = await pool.query<{
      order_id: string;
      detail_id: string;
      node_designation: string | null;
      root_product_count: string;
      revision_bazis_order_no: string | null;
      product_order_no: string | null;
    }>(`
      WITH mapped AS (
        SELECT od.order_id, od.detail_id, bn.designation AS node_designation, bn.revision_id,
               COUNT(*) OVER (PARTITION BY od.detail_id) AS mapping_count
        FROM order_details od
        JOIN bazis_node_order_detail_map mapping ON mapping.order_detail_id=od.detail_id
        JOIN bazis_nodes bn ON bn.bazis_node_id=mapping.node_id
        JOIN orders source_order ON source_order.order_id=od.order_id AND source_order.delete_flag=false
        JOIN sheet_material_types material ON material.sheet_material_type_id=od.sheet_material_type_id
        WHERE od.delete_flag=false
          AND NULLIF(btrim(material.name), '') IS NOT NULL
          AND material.thickness_mm > 0
          AND od.height > 0 AND od.width > 0
          AND od.quantity > 0 AND od.quantity=trunc(od.quantity)
      ), candidates AS (
        SELECT mapped.*,
               NULLIF(btrim(revision.bazis_order_no), '') AS revision_bazis_order_no,
               (
                 SELECT COUNT(*)
                 FROM bazis_nodes root
                 WHERE root.revision_id=mapped.revision_id
                   AND root.parent_node_id IS NULL
                   AND root.node_kind='product'
               ) AS root_product_count,
               (
                 SELECT NULLIF(btrim(root.raw_json->>'Заказ'), '')
                 FROM bazis_nodes root
                 WHERE root.revision_id=mapped.revision_id
                   AND root.parent_node_id IS NULL
                   AND root.node_kind='product'
                   AND NULLIF(btrim(root.raw_json->>'Заказ'), '') IS NOT NULL
                 ORDER BY root.seq
                 LIMIT 1
               ) AS product_order_no
        FROM mapped
        JOIN bazis_project_revisions revision ON revision.bazis_revision_id=mapped.revision_id
        WHERE mapped.mapping_count=1
      )
      SELECT DISTINCT ON (root_product_count > 1)
             order_id::text, detail_id::text, node_designation,
             root_product_count::text, revision_bazis_order_no, product_order_no
      FROM candidates
      ORDER BY (root_product_count > 1), detail_id
    `);
    if (candidates.rows.length === 0) return;

    const repository = new PgBazisCutRepository(database);
    for (const [index, candidate] of candidates.rows.entries()) {
      const created = await repository.create({
        currentUser: user,
        requestId: `${keyPrefix}-source-${index}`,
        idempotencyKey: `${keyPrefix}-source-${index}`,
        name: `IT source ${keyPrefix} ${index}`,
        orderId: Number(candidate.order_id),
        detailIds: [Number(candidate.detail_id)],
      });
      ownedSetIds.push(created.set.bazisCutSetId);
      expect(created.set.name).toBe(`БР-${created.set.bazisCutSetId}`);
      const detail = created.set.details[0];
      const rootProductCount = Number(candidate.root_product_count);
      const bazisProject = rootProductCount > 1
        ? candidate.revision_bazis_order_no ?? candidate.product_order_no ?? ''
        : '';
      const bazisOrder = rootProductCount > 1
        ? ''
        : candidate.product_order_no ?? candidate.revision_bazis_order_no ?? '';
      expect(detail.sourceBazisProjectName).toBe(bazisProject);
      expect(detail.sourceBazisOrderNo).toBe(bazisOrder);
      expect(detail.position).toBe(candidate.node_designation?.trim() ?? '');
    }
  });
});

function fields(overrides: Partial<BazisCutDetailFields> = {}): BazisCutDetailFields {
  const base: BazisCutDetailFields = {
    cutEnabled: true, materialType: 'Площадной', materialName: 'МДФ 16 мм', materialArticle: '',
    thicknessMm: 16, position: '001', partName: 'Фасад', finishedLengthMm: 1000,
    finishedWidthMm: 500, cutLengthMm: 1000, cutWidthMm: 500, quantity: 2,
    orientation: 'Не задана', groove: '', l1Name: '', l1Designation: '', l1ThicknessMm: 0,
    l2Name: '', l2Designation: '', l2ThicknessMm: 0, w1Name: '', w1Designation: '', w1ThicknessMm: 0,
    w2Name: '', w2Designation: '', w2ThicknessMm: 0, priority: null, comment: '', customProperty: '',
    glue: '', milling: '', route: '', film: '',
  };
  return { ...base, ...overrides };
}

function databaseFromPool(pool: Pool): DatabaseService {
  return {
    query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => pool.query<T>(sql, [...params]),
    transaction: async <T>(handler: (client: TransactionClient) => Promise<T>) => {
      const raw = await pool.connect();
      const client = transactionClient(raw);
      try { await raw.query('BEGIN'); const value = await handler(client); await raw.query('COMMIT'); return value; }
      catch (error) { await raw.query('ROLLBACK'); throw error; }
      finally { raw.release(); }
    },
  } as unknown as DatabaseService;
}

function transactionClient(raw: PoolClient): TransactionClient {
  return { raw, query: <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => raw.query<T>(sql, [...params]) };
}

async function count(pool: Pool, sql: string, params: readonly unknown[]): Promise<number> {
  const value = await pool.query<{ count: number }>(sql, [...params]);
  return Number(value.rows[0]?.count ?? 0);
}
