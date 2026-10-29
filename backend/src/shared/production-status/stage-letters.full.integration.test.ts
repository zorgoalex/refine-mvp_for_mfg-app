import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService, DatabaseTransactionOptions } from '../../database/database.service';
import { discardMdfCommandBoundary, enterMdfCommand } from '../../modules/mdf-board/application/mdf-command-boundary';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import { PgOrderSnapshot } from '../../modules/orders/adapters/pg-order-snapshot';
import type { OrderSnapshotDto } from '../../modules/orders/dto/order-snapshot.dto';
import { PgBazisCutRepository } from '../../modules/bazis-cut/adapters/pg-bazis-cut-repository';

/**
 * Migration 282 on a FULL copy of the stage schema (a separate database, never the shared one):
 * STAGE_LETTERS_FULL_DATABASE_URL. The real snapshot export → import (both formats, a deleted «Базис» detail) and the
 * real «Базис раскрой» commands in two connections on a mixed set (an ordinary row of one order, an HDF row of another).
 */
const databaseUrl = process.env.STAGE_LETTERS_FULL_DATABASE_URL;

describe.skipIf(!databaseUrl)('stage letters on the full schema (copy database)', () => {
  let pool: Pool;
  let admin: CurrentUser;
  const tag = randomUUID().slice(0, 8);

  function database(): DatabaseService {
    return {
      async transaction<T>(handler: (tx: TransactionClient) => Promise<T>, options: DatabaseTransactionOptions & { isolation?: string } = {}): Promise<T> {
        const client: PoolClient = await pool.connect();
        const tx = { raw: client, query: (text: string, params: readonly unknown[] = []) => { executedSql.push(text); return client.query(text, [...params]); } } as unknown as TransactionClient;
        try {
          await client.query('BEGIN');
          if (options.mdf) {
            await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await enterMdfCommand(tx, options.mdf);
          } else if (options.isolation) {
            await client.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
          }
          await client.query("SET LOCAL lock_timeout = '90s'");
          const result = await handler(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          discardMdfCommandBoundary(tx);
          client.release();
        }
      },
      query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
    } as unknown as DatabaseService;
  }

  const statusId = async (code: string) => Number((await pool.query(
    'SELECT production_status_id FROM production_statuses WHERE production_status_code = $1', [code])).rows[0].production_status_id);
  const routesOf = async (orderId: number) => (await pool.query<{ detail_number: number; round_no: number }>(
    `SELECT od.detail_number, r.round_no FROM order_detail_stage_routes r JOIN order_details od ON od.detail_id = r.detail_id
      WHERE od.order_id = $1 ORDER BY 1, 2`, [orderId])).rows;
  const lettersOf = async (orderId: number) => (await pool.query<{ codes: string[] }>(
    'SELECT codes FROM order_stage_letter_codes(ARRAY[$1::bigint])', [orderId])).rows[0].codes;

  let savedMode: string | null = null;
  const executedSql: string[] = [];
  const savedAutomation = process.env.BACKEND_STATUS_AUTOMATION;
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    // the copy runs the legacy MDF path (the old set commands and their automation — the lock order under test)
    savedMode = (await pool.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode ?? null;
    await pool.query("UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton");
    // the legacy MDF automation runs (its owner lock is what the protocol must agree with)
    process.env.BACKEND_STATUS_AUTOMATION = 'true';
    const user = (await pool.query<{ user_id: string }>("SELECT user_id FROM users ORDER BY user_id LIMIT 1")).rows[0];
    admin = { id: String(user.user_id), username: `e2e_stage_letters_${tag}`, role: 'admin', roleId: 1, permissions: getPermissionsForRole('admin') };
  });

  afterAll(async () => {
    if (savedMode) await pool.query('UPDATE mdf_engine_state SET mode = $1 WHERE singleton', [savedMode]);
    if (savedAutomation === undefined) delete process.env.BACKEND_STATUS_AUTOMATION; else process.env.BACKEND_STATUS_AUTOMATION = savedAutomation;
    await pool?.end();
  });

  /** A production order of round 1 with at least three live details (the copy has the prod dump). */
  async function pickOrder(skip = 0): Promise<{ orderId: number; detailIds: number[] }> {
    const row = (await pool.query<{ order_id: string; ids: string[] }>(
      `SELECT o.order_id, array_agg(od.detail_id ORDER BY od.detail_number, od.detail_id) AS ids
         FROM orders o JOIN order_details od ON od.order_id = o.order_id AND NOT od.delete_flag
        WHERE o.order_kind = 'production_order' AND NOT o.delete_flag AND o.production_round = 1
        GROUP BY o.order_id HAVING count(*) >= 3
        ORDER BY o.order_id DESC OFFSET $1 LIMIT 1`, [skip])).rows[0];
    return { orderId: Number(row.order_id), detailIds: row.ids.map(Number) };
  }

  it('export → import keeps the «Базис» routes of live details (both formats); a deleted «Базис» detail does not break the import', async () => {
    const { orderId, detailIds } = await pickOrder();
    const [sawDetail, cutDetail, deletedDetail] = detailIds;
    await pool.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [sawDetail, await statusId('saw')]);
    await pool.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [cutDetail, await statusId('cut')]);
    await pool.query('UPDATE order_details SET production_status_id = $2 WHERE detail_id = $1', [deletedDetail, await statusId('saw')]);
    await pool.query('UPDATE order_details SET delete_flag = true WHERE detail_id = $1', [deletedDetail]);

    const snapshots = new PgOrderSnapshot(database());
    const exported = JSON.parse((await snapshots.exportOrderSnapshot({ orderId, currentUser: admin, requestId: `e2e-${tag}` })).content) as OrderSnapshotDto;
    // the routes of the live details only (the copy already has routes from the «Базис раскрой» cards); never the deleted one
    const liveRoutes = (await pool.query<{ detail_id: string }>(
      `SELECT r.detail_id FROM order_detail_stage_routes r JOIN order_details od ON od.detail_id = r.detail_id
        WHERE od.order_id = $1 AND NOT od.delete_flag ORDER BY r.detail_id`, [orderId])).rows.map((row) => row.detail_id);
    expect(liveRoutes).toContain(String(sawDetail));
    expect(exported.data.stageRoutes?.map((route) => route.detailSourceId)).toEqual(liveRoutes);
    expect(exported.data.stageRoutes?.map((route) => route.detailSourceId)).not.toContain(String(deletedDetail));


    for (const format of ['with-routes', 'old'] as const) {
      const copy = JSON.parse(JSON.stringify(exported)) as OrderSnapshotDto;
      if (format === 'old') delete copy.data.stageRoutes;
      copy.source.sourceInstanceId = `e2e-stage-letters-${tag}-${format}`;
      copy.source.payloadHash = '';
      copy.data.order.orderName = `E2E-Тест буквы ${tag} ${format}`;
      const imported = await snapshots.importOrderSnapshot({ snapshot: copy, currentUser: admin, requestId: `e2e-${tag}-${format}` });
      if (format === 'with-routes') {
        // exactly the source's routes of live details (the import renumbers details, so compare counts and rounds)
        const importedRoutes = await routesOf(imported.orderId);
        expect(importedRoutes.length).toBe(liveRoutes.length);
        expect(new Set(importedRoutes.map((route) => route.round_no))).toEqual(new Set([1]));
      } else {
        // an old file: a route only for the «Базис» (saw) details, in their round
        const importedRoutes = await routesOf(imported.orderId);
        const sawCount = Number((await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM order_details od JOIN production_statuses ps USING (production_status_id)
            WHERE od.order_id = $1 AND NOT od.delete_flag AND ps.production_status_code = 'saw'`, [imported.orderId])).rows[0].n);
        expect(sawCount).toBe(1);
        expect(importedRoutes).toEqual([expect.objectContaining({ round_no: 1 })]);
      }
      if (format === 'with-routes') expect(await lettersOf(imported.orderId)).toEqual(await lettersOf(orderId));
    }
  });

  const FIELD_KEYS = ['cutEnabled', 'materialType', 'materialName', 'materialArticle', 'thicknessMm', 'position', 'partName',
    'finishedLengthMm', 'finishedWidthMm', 'cutLengthMm', 'cutWidthMm', 'quantity', 'orientation', 'groove', 'l1Name',
    'l1Designation', 'l1ThicknessMm', 'l2Name', 'l2Designation', 'l2ThicknessMm', 'w1Name', 'w1Designation', 'w1ThicknessMm',
    'w2Name', 'w2Designation', 'w2ThicknessMm', 'priority', 'comment', 'customProperty', 'glue', 'milling', 'route', 'film'] as const;
  const outcome = (result: PromiseSettledResult<unknown>) => (result.status === 'fulfilled'
    ? 'ok' : String((result.reason as { code?: string }).code ?? (result.reason as Error).message));
  // one command wins; the other is refused by the version or the set check — never a deadlock or a lock timeout
  const expectOneWins = (results: PromiseSettledResult<unknown>[]) => {
    const codes = results.map(outcome);
    expect(codes.filter((code) => code === 'ok'), codes.join(' | ')).toHaveLength(1);
    for (const code of codes.filter((value) => value !== 'ok')) {
      expect(['BAZIS_CUT_SET_STALE_VERSION', 'BAZIS_CUT_SET_CHANGED'], codes.join(' | ')).toContain(code);
    }
  };

  it('real «Базис раскрой» commands in two connections on a mixed set (legacy path): add HDF ↔ add a detail of the same order; update ↔ add', async () => {
    expect((await pool.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0].mode).toBe('legacy');
    // order X: an ordinary detail and an HDF position (status ok); order Y: the first row of the set
    const x = (await pool.query<{ order_id: string; detail_id: string; hdf_id: string }>(
      `SELECT o.order_id, min(od.detail_id) AS detail_id, min(hd.order_hdf_detail_id) AS hdf_id
         FROM orders o
         JOIN order_details od ON od.order_id = o.order_id AND NOT od.delete_flag
         JOIN order_hdf_details hd ON hd.order_id = o.order_id AND NOT hd.delete_flag AND hd.hdf_enabled AND hd.status = 'ok'
        WHERE o.order_kind = 'production_order' AND NOT o.delete_flag
        GROUP BY o.order_id ORDER BY o.order_id DESC LIMIT 1`)).rows[0];
    // the set's own order Y sorts after X (the case of the finding: the set holds a later order, the HDF of an earlier one joins)
    const yRow = (await pool.query<{ order_id: string; ids: string[] }>(
      `SELECT o.order_id, array_agg(od.detail_id ORDER BY od.detail_id) AS ids
         FROM orders o JOIN order_details od ON od.order_id = o.order_id AND NOT od.delete_flag
        WHERE o.order_kind = 'production_order' AND NOT o.delete_flag AND o.order_id > $1
          AND NOT EXISTS (SELECT 1 FROM bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id)
        GROUP BY o.order_id HAVING count(*) >= 3 ORDER BY o.order_id LIMIT 1`, [x.order_id])).rows[0];
    const y = { orderId: Number(yRow.order_id), detailIds: yRow.ids.map(Number) };
    const repository = new PgBazisCutRepository(database());
    const created = await repository.create({
      currentUser: admin, requestId: `e2e-${tag}-create`, idempotencyKey: `e2e-${tag}-create`,
      orderId: y.orderId, detailIds: [y.detailIds[0]],
    } as never);
    const setId = created.set.bazisCutSetId;
    const version = async () => Number((await pool.query('SELECT version FROM bazis_cut_sets WHERE bazis_cut_set_id = $1', [setId])).rows[0].version);

    // the HDF position of X joins first, alone (it must succeed: the mixed set is the premise of the scenario)
    await repository.addDetails({ currentUser: admin, requestId: `e2e-${tag}-hdf`, idempotencyKey: `e2e-${tag}-hdf`,
      setId, orderId: Number(x.order_id), detailIds: [], hdfDetailIds: [Number(x.hdf_id)], expectedVersion: await version() } as never);
    expect((await pool.query('SELECT 1 FROM bazis_cut_set_details WHERE bazis_cut_set_id = $1 AND source_order_hdf_detail_id = $2',
      [setId, x.hdf_id])).rowCount).toBe(1);

    // a controlled overlap: a third connection holds the set; both commands start, take what they take first and queue
    const overlap = async (commands: Array<() => Promise<unknown>>) => {
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM bazis_cut_sets WHERE bazis_cut_set_id = $1 FOR UPDATE', [setId]);
        const running = commands.map((command) => command());
        await new Promise((resolve) => setTimeout(resolve, 700));
        await blocker.query('COMMIT');
        return await Promise.allSettled(running);
      } finally {
        blocker.release();
      }
    };

    let v = await version();
    expectOneWins(await overlap([
      () => repository.addDetails({ currentUser: admin, requestId: `e2e-${tag}-det`, idempotencyKey: `e2e-${tag}-det`,
        setId, orderId: Number(x.order_id), detailIds: [Number(x.detail_id)], expectedVersion: v } as never),
      () => repository.addDetails({ currentUser: admin, requestId: `e2e-${tag}-det2`, idempotencyKey: `e2e-${tag}-det2`,
        setId, orderId: y.orderId, detailIds: [y.detailIds[1]], expectedVersion: v } as never),
    ]));

    // update ↔ add over the mixed set (an ordinary row of Y, the HDF row of X)
    const set = (await repository.get({ currentUser: admin, setId } as never)) as { details: Array<Record<string, unknown>> };
    const row = set.details.find((detail) => detail.sourceOrderDetailId === y.detailIds[0])!;
    const fields = Object.fromEntries(FIELD_KEYS.map((key) => [key, row[key]]));
    v = await version();
    expectOneWins(await overlap([
      () => repository.updateDetail({ currentUser: admin, requestId: `e2e-${tag}-upd`, idempotencyKey: `e2e-${tag}-upd`,
        setId, detailId: row.bazisCutSetDetailId, expectedVersion: v, fields: { ...fields, comment: `e2e ${tag}` } } as never),
      () => repository.addDetails({ currentUser: admin, requestId: `e2e-${tag}-add2`, idempotencyKey: `e2e-${tag}-add2`,
        setId, orderId: y.orderId, detailIds: [y.detailIds[2]], expectedVersion: v } as never), // a detail not in the set yet
    ]));
    // the legacy automation really ran its owner lock (the protocol under test)
    expect(executedSql.some((sql) => sql.includes('cnc_telegram_packet_items i LEFT JOIN named_owners'))).toBe(true);
    const owners = (await pool.query<{ order_id: string }>(
      `SELECT DISTINCT COALESCE(i.source_order_id, d.order_id) AS order_id FROM bazis_cut_set_details i
         LEFT JOIN order_details d ON d.detail_id = i.source_order_detail_id WHERE i.bazis_cut_set_id = $1 ORDER BY 1`, [setId])).rows;
    expect(owners.length).toBe(2); // the mixed set really has rows of both orders
  });

  it('a shared bath: create (order B) ↔ update of a set of order A, under the legacy automation — no deadlock', async () => {
    const pair = (await pool.query<{ a: string; b: string }>(
      `SELECT min(p.order_id) AS a, max(p.order_id) AS b FROM cut_result_placement p
         JOIN orders o ON o.order_id = p.order_id AND o.order_kind = 'production_order' AND NOT o.delete_flag
        GROUP BY p.cut_result_id HAVING count(DISTINCT p.order_id) = 2
        ORDER BY p.cut_result_id DESC LIMIT 1`)).rows[0];
    expect(pair, 'the copy has a bath shared by two orders').toBeTruthy();
    const freeDetail = async (orderId: string) => Number((await pool.query<{ detail_id: string }>(
      `SELECT min(od.detail_id) AS detail_id FROM order_details od WHERE od.order_id = $1 AND NOT od.delete_flag`, [orderId])).rows[0].detail_id);
    const repository = new PgBazisCutRepository(database());
    const setA = (await repository.create({ currentUser: admin, requestId: `e2e-${tag}-bath-a`, idempotencyKey: `e2e-${tag}-bath-a`,
      orderId: Number(pair.a), detailIds: [await freeDetail(pair.a)] } as never)).set.bazisCutSetId;
    const set = (await repository.get({ currentUser: admin, setId: setA } as never)) as { version: number; details: Array<Record<string, unknown>> };
    const row = set.details[0];
    const fields = Object.fromEntries(FIELD_KEYS.map((key) => [key, row[key]]));
    // the update of A's set reaches the automation (its owner lock), alone first
    executedSql.length = 0;
    await repository.updateDetail({ currentUser: admin, requestId: `e2e-${tag}-bath-u0`, idempotencyKey: `e2e-${tag}-bath-u0`,
      setId: setA, detailId: row.bazisCutSetDetailId, expectedVersion: set.version, fields: { ...fields, comment: `e2e ${tag} 0` } } as never);
    expect(executedSql.some((sql) => sql.includes('cnc_telegram_packet_items i LEFT JOIN named_owners'))).toBe(true);
    const version = Number((await pool.query('SELECT version FROM bazis_cut_sets WHERE bazis_cut_set_id = $1', [setA])).rows[0].version);

    const blocker = await pool.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM bazis_cut_sets WHERE bazis_cut_set_id = $1 FOR UPDATE', [setA]);
      executedSql.length = 0;
      const running = [
        repository.updateDetail({ currentUser: admin, requestId: `e2e-${tag}-bath-u`, idempotencyKey: `e2e-${tag}-bath-u`,
          setId: setA, detailId: row.bazisCutSetDetailId, expectedVersion: version, fields: { ...fields, comment: `e2e ${tag} 1` } } as never),
        repository.create({ currentUser: admin, requestId: `e2e-${tag}-bath-b`, idempotencyKey: `e2e-${tag}-bath-b`,
          orderId: Number(pair.b), detailIds: [await freeDetail(pair.b)] } as never),
      ];
      await new Promise((resolve) => setTimeout(resolve, 700));
      await blocker.query('COMMIT');
      results = await Promise.allSettled(running);
    } finally {
      blocker.release();
    }
    expect(results.map(outcome)).toEqual(['ok', 'ok']);
    // the create of B also ran the automation's owner lock (B and its bath neighbour A)
    expect(executedSql.filter((sql) => sql.includes('cnc_telegram_packet_items i LEFT JOIN named_owners')).length).toBeGreaterThanOrEqual(2);
  });

  it('a detail transferred to another order: delete of its row ↔ add of a detail of the new order — no deadlock', async () => {
    const [from, to] = [await pickOrder(5), await pickOrder(6)];
    const repository = new PgBazisCutRepository(database());
    const setId = (await repository.create({ currentUser: admin, requestId: `e2e-${tag}-tr`, idempotencyKey: `e2e-${tag}-tr`,
      orderId: from.orderId, detailIds: [from.detailIds[0]] } as never)).set.bazisCutSetId;
    // the transfer outcome: the detail now belongs to «to», the card row keeps source_order_id = «from»
    await pool.query('UPDATE order_details SET order_id = $2 WHERE detail_id = $1', [from.detailIds[0], to.orderId]);
    const rowId = Number((await pool.query('SELECT bazis_cut_set_detail_id FROM bazis_cut_set_details WHERE bazis_cut_set_id = $1', [setId])).rows[0].bazis_cut_set_detail_id);
    const version = Number((await pool.query('SELECT version FROM bazis_cut_sets WHERE bazis_cut_set_id = $1', [setId])).rows[0].version);
    const blocker = await pool.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM bazis_cut_sets WHERE bazis_cut_set_id = $1 FOR UPDATE', [setId]);
      const running = [
        repository.deleteDetail({ currentUser: admin, requestId: `e2e-${tag}-tr-d`, idempotencyKey: `e2e-${tag}-tr-d`,
          setId, detailId: rowId, expectedVersion: version } as never),
        repository.addDetails({ currentUser: admin, requestId: `e2e-${tag}-tr-a`, idempotencyKey: `e2e-${tag}-tr-a`,
          setId, orderId: to.orderId, detailIds: [to.detailIds[0]], expectedVersion: version } as never),
      ];
      await new Promise((resolve) => setTimeout(resolve, 700));
      await blocker.query('COMMIT');
      results = await Promise.allSettled(running);
    } finally {
      blocker.release();
    }
    expectOneWins(results);
  });
});
