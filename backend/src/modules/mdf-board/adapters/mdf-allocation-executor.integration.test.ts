import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { recordMdfReceipt, type MdfReceiptInput, type MdfReceiptLine } from '../application/mdf-receipt';
import { executeMdfAllocation } from './mdf-allocation-executor';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF allocation executor real PostgreSQL', () => {
  const schema = `e2e_mdf_alloc_${randomUUID().replaceAll('-', '')}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off' };
  const db = new Client(config);
  let nextOrder = 0;
  const tx = async <T>(fn: (client: DatabaseClient) => Promise<T>, client = db): Promise<T> => {
    await client.query('BEGIN');
    try { const result = await fn({ query: (sql, args) => client.query(sql, args ? [...args] : []) });
      await client.query('COMMIT'); return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  };
  beforeAll(async () => {
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`);
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql']) {
      await db.query(readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.query(`CREATE TABLE orders(order_id bigint PRIMARY KEY,delete_flag boolean NOT NULL DEFAULT false);
      CREATE TABLE cut_result(cut_result_id bigint PRIMARY KEY,created_at timestamptz NOT NULL);
      CREATE TABLE audit_log (LIKE public.audit_log INCLUDING DEFAULTS INCLUDING GENERATED);
      CREATE TABLE audit_log_related_entity(audit_id uuid,entity_type text,entity_id bigint,
        UNIQUE(audit_id,entity_type,entity_id));
      UPDATE mdf_engine_state SET mode='active'`);
  });
  afterAll(async () => {
    try {
      await db.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await db.end(); }
  });
  async function fixture(parts = [6, 4], bathQuantities = [10, 10], laminated = false) {
    const orderId = ++nextOrder, detailId = orderId * 10;
    await db.query('INSERT INTO orders(order_id) VALUES($1)', [orderId]);
    const line = (stage: string, quantity: number): MdfReceiptLine => ({ lineKey: stage, orderId, detailId, quantity,
      stageCode: stage, evidenceKind: stage === 'membership' ? 'derived' : 'physical', rework: false });
    const receipts: MdfReceiptInput[] = parts.map((q, i) => ({ sourceKind: i ? 'bazisCutSet' : 'packet',
      sourceId: `E2E-supply-${orderId}-${i}`, revisionKey: '1', origin: i ? 'manual' : 'cnc', actorUserId: 158,
      requestId: `E2E-allocation-${orderId}`, causeKey: `E2E-supply-${orderId}-${i}`, expectedFence: null,
      accept: true, rules: [], lines: [line('membership', q), line('cut', q)] }));
    const saved = [];
    for (const r of receipts) saved.push(await tx(c => recordMdfReceipt(c, r)));
    const bathIds = [];
    for (const [i, q] of bathQuantities.entries()) {
      const id = orderId * 100 + i; bathIds.push(`cut-result:${id}`);
      await db.query("INSERT INTO cut_result VALUES($1,'2026-09-01'::timestamptz+($2 * interval '1 day'))", [id, i]);
      await tx(c => recordMdfReceipt(c, { ...receipts[0], sourceKind: 'bath', sourceId: `cut-result:${id}`,
        origin: 'manual', causeKey: `E2E-bath-${id}`, lines: [line('membership', q), ...(laminated ? [line('laminated', q)] : [])] }));
    }
    return { orderId, detailId, receipts, saved, bathIds, jobId: saved[0].jobId };
  }
  const allocations = async (orderId: number) => (await db.query(`SELECT bath_id,quantity,state FROM mdf_bath_allocations
    WHERE order_id=$1 ORDER BY bath_id,quantity`, [orderId])).rows;
  async function independentPosition(f: Awaited<ReturnType<typeof fixture>>) {
    const id = f.orderId * 100 + 50, bathId = `cut-result:${id}`;
    const receipt = { ...f.receipts[0], sourceId: `E2E-independent-${f.orderId}`,
      lines: f.receipts[0].lines.map(l => ({ ...l, detailId: f.detailId + 1, quantity: 10 })) };
    const saved = await tx(c => recordMdfReceipt(c, receipt));
    await db.query("INSERT INTO cut_result VALUES($1,'2026-09-03')", [id]);
    await tx(c => recordMdfReceipt(c, { ...receipt, sourceKind: 'bath', sourceId: bathId, lines: [receipt.lines[0]] }));
    return { bathId, receipt, saved };
  }
  it('reserves independent portions once, audits actor/scope, and leaves job/publication to caller', async () => {
    const f = await fixture();
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ status: 'allocated', readyBathIds: [f.bathIds[0]], reservedCount: 2 });
    expect(await allocations(f.orderId)).toEqual([
      { bath_id: f.bathIds[0], quantity: '4', state: 'reserved' },
      { bath_id: f.bathIds[0], quantity: '6', state: 'reserved' },
    ]);
    expect((await db.query('SELECT event,user_id,request_id,entity_id FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows)
      .toEqual([{ event: 'mdf_board.bath_supply_reserved', user_id: '158', request_id: `E2E-allocation-${f.orderId}`, entity_id: f.bathIds[0] }]);
    expect((await db.query(`SELECT r.entity_type,r.entity_id FROM audit_log_related_entity r JOIN audit_log a USING(audit_id)
      WHERE a.related_order_id=$1 ORDER BY r.entity_type`, [f.orderId])).rows)
      .toEqual([{ entity_type: 'order', entity_id: String(f.orderId) }, { entity_type: 'order_detail', entity_id: String(f.detailId) }]);
    expect((await db.query('SELECT status FROM mdf_recalculation_jobs WHERE job_id=$1', [f.jobId])).rows[0].status).toBe('pending');
    expect((await db.query('SELECT published_revision FROM mdf_engine_state')).rows[0].published_revision).toBe('0');
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ reservedCount: 0, consumedCount: 0 });
    expect((await db.query('SELECT count(*) n FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows[0].n).toBe('1');
  });
  it('consumes only an entire bath with accepted lamination and never double-audits replay', async () => {
    const f = await fixture([10], [10], true);
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ reservedCount: 1, consumedCount: 1 });
    expect(await allocations(f.orderId)).toEqual([{ bath_id: f.bathIds[0], quantity: '10', state: 'consumed' }]);
    await tx(c => executeMdfAllocation(c, f.jobId));
    expect((await db.query('SELECT count(*) n FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows[0].n).toBe('2');
  });
  it('blocks pending newer receipt without silently using stale accepted quantities', async () => {
    const f = await fixture([10]);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2', accept: false,
      expectedFence: { version: '1', correctionEpoch: '0' } }));
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ readyBathIds: [], reservedCount: 0,
      quarantine: [expect.objectContaining({ code: 'ACCEPTANCE_PENDING' })] });
    expect(await allocations(f.orderId)).toEqual([]);
  });
  it('stale job cannot reserve supply after source revision advances', async () => {
    const f = await fixture([10]);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2', expectedFence: { version: '1', correctionEpoch: '0' } }));
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ status: 'superseded' });
    expect(await allocations(f.orderId)).toEqual([]);
  });
  it.each(['legacy', 'shadow', 'read_only'])('does not mutate in %s mode', async mode => {
    const f = await fixture([10]);
    await db.query('UPDATE mdf_engine_state SET mode=$1', [mode]);
    try {
      expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ status: 'disabled' });
      expect(await allocations(f.orderId)).toEqual([]);
    } finally { await db.query("UPDATE mdf_engine_state SET mode='active'"); }
  });
  it('rejects repeatable-read, which could miss a closure change after lock wait', async () => {
    const f = await fixture([10]);
    await expect(tx(async c => { await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return executeMdfAllocation(c, f.jobId); })).rejects.toThrow('MDF_ALLOCATION_ISOLATION');
  });
  it('retains allocations if old bath source disappears; does not give them to a new bath', async () => {
    const f = await fixture([10]); await tx(c => executeMdfAllocation(c, f.jobId));
    await db.query('DELETE FROM cut_result WHERE cut_result_id=$1', [Number(f.bathIds[0].split(':')[1])]);
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ readyBathIds: [], reservedCount: 0,
      quarantine: [expect.objectContaining({ code: 'BATH_METADATA_MISSING' })] });
    expect((await allocations(f.orderId)).every(a => a.bath_id === f.bathIds[0])).toBe(true);
  });
  it('rolls reservations and audit back on downstream failure', async () => {
    const f = await fixture([10]);
    await expect(tx(async c => { await executeMdfAllocation(c, f.jobId); await c.query('SELECT 1/0'); }))
      .rejects.toMatchObject({ code: '22012' });
    expect(await allocations(f.orderId)).toEqual([]);
    expect((await db.query('SELECT count(*) n FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows[0].n).toBe('0');
  });
  it('two simultaneous jobs reserve the same accepted stock once', async () => {
    const f = await fixture(); const other = new Client(config); await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      const results = await Promise.all([tx(c => executeMdfAllocation(c, f.saved[0].jobId)),
        tx(c => executeMdfAllocation(c, f.saved[1].jobId), other)]);
      expect(results.map(r => r.reservedCount).sort()).toEqual([0, 2]);
      expect(await allocations(f.orderId)).toHaveLength(2);
    } finally { await other.end(); }
  });
  it('audit insertion failure rolls back allocations rather than leaving unaudited reservations', async () => {
    const f = await fixture([10]);
    await expect(tx(async c => {
      await c.query(`ALTER TABLE audit_log ADD CONSTRAINT e2e_reject_allocation_audit CHECK (related_order_id<>${f.orderId})`);
      return executeMdfAllocation(c, f.jobId);
    })).rejects.toMatchObject({ code: '23514' });
    expect(await allocations(f.orderId)).toEqual([]);
    expect((await db.query('SELECT count(*) n FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows[0].n).toBe('0');
  });
  it.each(['declaration', 'rework'] as const)('does not allocate %s as normal physical cut', async kind => {
    const f = await fixture([10]);
    const saved = await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2',
      expectedFence: { version: '1', correctionEpoch: '0' }, lines: f.receipts[0].lines.map(l => l.stageCode !== 'cut' ? l
        : { ...l, rework: kind === 'rework', evidenceKind: kind === 'declaration' ? 'declaration' : 'physical' }) }));
    expect(await tx(c => executeMdfAllocation(c, saved.jobId))).toMatchObject({ readyBathIds: [], reservedCount: 0 });
  });
  it('requires full own lamination before consuming reserved supply', async () => {
    const f = await fixture([10], [10]);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], sourceKind: 'bath', sourceId: f.bathIds[0],
      revisionKey: '2', expectedFence: { version: '1', correctionEpoch: '0' }, lines: [f.receipts[0].lines[0],
        { ...f.receipts[0].lines[1], lineKey: 'laminated', stageCode: 'laminated', quantity: 5 }] }));
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ reservedCount: 1, consumedCount: 0 });
    expect((await allocations(f.orderId))[0].state).toBe('reserved');
  });
  it('does not migrate reservations onto a different bath revision without correction', async () => {
    const f = await fixture([10], [10]); await tx(c => executeMdfAllocation(c, f.jobId));
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], sourceKind: 'bath', sourceId: f.bathIds[0],
      revisionKey: '2', expectedFence: { version: '1', correctionEpoch: '0' }, lines: [f.receipts[0].lines[0]] }));
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ readyBathIds: [], reservedCount: 0,
      quarantine: [expect.objectContaining({ code: 'ACCEPTANCE_PENDING' })] });
    expect((await db.query('SELECT bath_revision FROM mdf_bath_allocations WHERE order_id=$1', [f.orderId])).rows)
      .toEqual([{ bath_revision: '1' }]);
  });
  it('uses original bath creation time, not receipt insertion order', async () => {
    const f = await fixture([10]);
    await db.query("UPDATE cut_result SET created_at='2026-08-01' WHERE cut_result_id=$1", [Number(f.bathIds[1].split(':')[1])]);
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ readyBathIds: [f.bathIds[1]] });
  });
  it('pending CNC does not suppress verified BASIS supply for the same position', async () => {
    const f = await fixture([10, 10], [10]);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2', accept: false,
      expectedFence: { version: '1', correctionEpoch: '0' } }));
    expect(await tx(c => executeMdfAllocation(c, f.saved[1].jobId))).toMatchObject({ readyBathIds: f.bathIds, reservedCount: 1 });
    expect((await db.query(`SELECT e.source_kind FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
      WHERE a.order_id=$1`, [f.orderId])).rows).toEqual([{ source_kind: 'bazisCutSet' }]);
  });
  it('pending bath blocks its consumption balance, not another position in the same order', async () => {
    const f = await fixture([10], [10]); const other = await independentPosition(f);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], sourceKind: 'bath', sourceId: f.bathIds[0],
      revisionKey: '2', accept: false, expectedFence: { version: '1', correctionEpoch: '0' }, lines: [f.receipts[0].lines[0]] }));
    const result = await tx(c => executeMdfAllocation(c, f.jobId));
    expect(result).toMatchObject({ readyBathIds: [other.bathId], reservedCount: 1, consumedCount: 0 });
    expect(await allocations(f.orderId)).toEqual([{ bath_id: other.bathId, quantity: '10', state: 'reserved' }]);
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ reservedCount: 0, consumedCount: 0 });
    expect((await db.query('SELECT count(*) n FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows[0].n).toBe('1');
  });
  it('allocated stale source never frees stock; independent position still progresses', async () => {
    const f = await fixture([10]); await tx(c => executeMdfAllocation(c, f.jobId));
    const before = await allocations(f.orderId); const other = await independentPosition(f);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2', accept: false,
      expectedFence: { version: '1', correctionEpoch: '0' } }));
    expect(await tx(c => executeMdfAllocation(c, other.saved.jobId))).toMatchObject({ readyBathIds: [other.bathId], reservedCount: 1 });
    expect(await allocations(f.orderId)).toEqual(expect.arrayContaining(before));
    expect((await allocations(f.orderId)).some(a => a.bath_id === f.bathIds[1])).toBe(false);
  });
  it('unaccounted lamination remains local, never consumes unrelated reservations', async () => {
    const f = await fixture([10], [10], true); const other = await independentPosition(f);
    const saved = await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2',
      expectedFence: { version: '1', correctionEpoch: '0' }, lines: [f.receipts[0].lines[0]] }));
    expect(await tx(c => executeMdfAllocation(c, saved.jobId))).toMatchObject({ readyBathIds: [other.bathId],
      reservedCount: 1, consumedCount: 0, quarantine: [expect.objectContaining({ code: 'LAMINATION_SUPPLY_MISSING' })] });
  });
  it('quarantined mixed lamination preserves but does not consume its valid other-position reserve', async () => {
    const f = await fixture([10], [10]); const other = await independentPosition(f);
    const id = f.orderId * 100 + 60, bathId = `cut-result:${id}`;
    await db.query("INSERT INTO cut_result VALUES($1,'2026-09-04')", [id]);
    const members = [f.receipts[0].lines[0], { ...other.receipt.lines[0], lineKey: 'member-other' }];
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], sourceKind: 'bath', sourceId: bathId,
      lines: [...members, ...members.map(l => ({ ...l, lineKey: `${l.lineKey}-rolled`, stageCode: 'laminated', evidenceKind: 'physical' as const }))] }));
    await tx(c => c.query(`INSERT INTO mdf_bath_allocations
      (evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key)
      SELECT evidence_line_id,$1,'1',order_id,detail_id,quantity,'reserved','E2E-historic-reserve'
      FROM mdf_evidence_lines WHERE source_kind='packet' AND source_id=$2 AND stage_code='cut'`, [bathId,other.receipt.sourceId]));
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], sourceKind: 'bath', sourceId: f.bathIds[0],
      revisionKey: '2', accept: false, expectedFence: { version: '1', correctionEpoch: '0' }, lines: members.slice(0,1) }));
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ readyBathIds: [], reservedCount: 0, consumedCount: 0 });
    expect(await allocations(f.orderId)).toEqual([{ bath_id: bathId, quantity: '10', state: 'reserved' }]);
    expect((await db.query('SELECT count(*) n FROM audit_log WHERE related_order_id=$1', [f.orderId])).rows[0].n).toBe('0');
  });
  it('concurrent passes with quarantine reserve independent supply once', async () => {
    const f = await fixture([10,10],[10]);
    await tx(c => recordMdfReceipt(c, { ...f.receipts[0], revisionKey: '2', accept: false,
      expectedFence: { version: '1', correctionEpoch: '0' } }));
    const other = new Client(config); await other.connect();
    try {
      await other.query(`SET search_path=${schema},public`);
      const results = await Promise.all([tx(c => executeMdfAllocation(c,f.jobId)),
        tx(c => executeMdfAllocation(c,f.saved[1].jobId),other)]);
      expect(results.map(r => r.reservedCount).sort()).toEqual([0,1]);
      expect(await allocations(f.orderId)).toHaveLength(1);
    } finally { await other.end(); }
  });
  it('epoch correction fences reject an old job even when accepted revision did not change', async () => {
    const f = await fixture([10]);
    await db.query(`UPDATE mdf_source_heads SET correction_epoch=correction_epoch+1,version=version+1
      WHERE source_kind='packet' AND source_id=$1`, [f.receipts[0].sourceId]);
    expect(await tx(c => executeMdfAllocation(c, f.jobId))).toMatchObject({ status: 'superseded' });
    expect(await allocations(f.orderId)).toEqual([]);
  });
  it('retries the whole component if membership expands while waiting for an owner lock', async () => {
    const f = await fixture([10], [10]);
    const otherOrder = ++nextOrder;
    await db.query('INSERT INTO orders(order_id) VALUES($1)', [otherOrder]);
    const other = new Client(config); await other.connect();
    let waiting: Promise<unknown> | undefined;
    let entered: () => void = () => {};
    const atOwnerLock = new Promise<void>(resolve => { entered = resolve; });
    try {
      await other.query(`SET search_path=${schema},public`);
      await db.query('BEGIN');
      await db.query('SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE', [[f.orderId, otherOrder]]);
      waiting = tx(c => executeMdfAllocation({ query: (sql, args, options) => {
        if (sql.startsWith('SELECT order_id FROM orders')) entered();
        return c.query(sql, args, options);
      } }, f.jobId), other).then(() => 'unexpected-success', (e: Error) => e.message);
      await Promise.race([atOwnerLock, waiting.then(() => { throw new Error('Executor exited before owner lock'); })]);
      await recordMdfReceipt({ query: (sql, args) => db.query(sql, args ? [...args] : []) }, {
        ...f.receipts[0], revisionKey: '2', expectedFence: { version: '1', correctionEpoch: '0' },
        lines: [...f.receipts[0].lines, { ...f.receipts[0].lines[0], lineKey: 'new-member',
          orderId: otherOrder, detailId: otherOrder * 10, quantity: 1 }],
      });
      await db.query('COMMIT');
      expect(await waiting).toBe('MDF_ALLOCATION_SCOPE_CHANGED');
      expect(await allocations(f.orderId)).toEqual([]);
    } finally { await db.query('ROLLBACK'); await waiting; await other.end(); }
  });
});
