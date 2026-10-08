import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { InMemoryOnecStockSnapshots } from './onec-stock-snapshots.in-memory';
import { STOCK_SNAPSHOT_MAX_ROWS, type StockSnapshotRow } from './onec-stock-snapshots.port';

const actor = { id: '7', username: 'keeper', role: 'manager', roleId: 10, permissions: [] } as unknown as CurrentUser;
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const ITEM = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const row = (warehouseRefKey: string | null, quantity: number): StockSnapshotRow => ({
  organizationRefKey: null, itemRefKey: ITEM, characteristicRefKey: null, batchRefKey: null, warehouseRefKey, cellRefKey: null, quantity,
});

describe('in-memory stock snapshots (the contract of the port for consumer tests)', () => {
  const fresh = () => new InMemoryOnecStockSnapshots({ now: () => new Date('2026-10-08T06:00:00Z') });

  it('queues a snapshot, tells both forms of the moment and the place in the line', async () => {
    const port = fresh();
    const first = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-1' }, actor, 'req-1');
    expect(first).toMatchObject({
      id: 1, sourceId: 1, currentSource: true, momentLocal: '2026-09-26T10:14:00', momentUtc: '2026-09-26T05:14:00.000Z', timeZone: 'Asia/Almaty',
      status: 'requested', requestedBy: { id: 7, name: 'keeper' }, queuePosition: 1, activeAhead: false, rowsCount: null, deletedAt: null,
    });
    const second = await port.request({ momentLocal: '2026-09-27T00:00:00', idempotencyKey: 'request-2' }, actor, 'req-2');
    expect(second).toMatchObject({ id: 2, queuePosition: 2, activeAhead: true });
    port.start(1);
    expect(await port.get(1)).toMatchObject({ status: 'syncing', queuePosition: 0, activeAhead: false });
    expect(await port.get(2)).toMatchObject({ queuePosition: 2, activeAhead: true });
    port.complete(1, [row(W1, 2)]);
    expect(await port.get(1)).toMatchObject({ status: 'ready', queuePosition: null, rowsCount: 1 });
    expect(await port.get(2)).toMatchObject({ queuePosition: 1, activeAhead: false });
  });

  it('the same moment returns the existing snapshot; force and another key make a new one; the same key always repeats', async () => {
    const port = fresh();
    const first = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-1' }, actor, 'r');
    expect((await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-2' }, actor, 'r')).id).toBe(first.id);
    port.complete(first.id, []);
    expect((await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-3' }, actor, 'r')).id).toBe(first.id);
    const forced = await port.request({ momentLocal: '2026-09-26T10:14:00', force: true, idempotencyKey: 'request-4' }, actor, 'r');
    expect(forced.id).not.toBe(first.id);
    expect((await port.request({ momentLocal: '2026-09-26T10:14:00', force: true, idempotencyKey: 'request-4' }, actor, 'r')).id).toBe(forced.id);
    // A failed snapshot is not an answer to a new request of the same moment.
    port.fail(forced.id, 'SYNC_TIMEOUT');
    await port.delete(first.id, actor, 'r');
    expect((await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-5' }, actor, 'r')).id).toBeGreaterThan(forced.id);
  });

  it('refuses a malformed or future moment, a bad key, an unknown source and a switched-off module', async () => {
    const port = fresh();
    expect(await code(port.request({ momentLocal: '26.09.2026 10:14', idempotencyKey: 'request-1' }, actor, 'r'))).toBe('VALIDATION_ERROR');
    expect(await code(port.request({ momentLocal: '2026-10-08T11:00:01', idempotencyKey: 'request-1' }, actor, 'r'))).toBe('VALIDATION_ERROR');
    expect(await code(port.request({ momentLocal: '2026-10-08T11:00:00', idempotencyKey: 'request-1' }, actor, 'r'))).toBe('ok');
    expect(await code(port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'short' }, actor, 'r'))).toBe('VALIDATION_ERROR');
    expect(await code(port.request({ sourceId: 9, momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-2' }, actor, 'r'))).toBe('VALIDATION_ERROR');
    expect(await port.capabilities()).toEqual({ readAvailable: true, commandsAvailable: true, reason: null });
    expect(await port.capabilities(9)).toEqual({ readAvailable: true, commandsAvailable: false, reason: 'SOURCE_NOT_CONFIGURED' });
    port.agentTooOld = true;
    expect(await port.capabilities()).toEqual({ readAvailable: true, commandsAvailable: false, reason: 'AGENT_TOO_OLD' });
    expect(await code(port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-0' }, actor, 'r'))).toBe('ONEC_STOCK_SNAPSHOTS_UNAVAILABLE');
    port.agentTooOld = false;
    port.enabled = false;
    expect(await port.capabilities()).toEqual({ readAvailable: true, commandsAvailable: false, reason: 'MODULE_DISABLED' });
    expect(await code(port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-3' }, actor, 'r'))).toBe('ONEC_STOCK_SNAPSHOTS_UNAVAILABLE');
    // Switched off: what is stored stays readable, and the history can still be cleaned.
    const stored = (await port.list()).items;
    expect(stored).toHaveLength(1);
    expect((await port.get(stored[0].id)).status).toBe('requested');
    await port.delete(stored[0].id, actor, 'r');
    expect(await port.get(stored[0].id, { includeDeleted: true })).toMatchObject({ status: 'failed', errorCode: 'CANCELLED' });
  });

  it('rows and summary only of a ready snapshot; keys in lower case; the warehouse filter', async () => {
    const port = fresh();
    const { id } = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-1' }, actor, 'r');
    expect(await code(port.rows(id))).toBe('ONEC_STOCK_SNAPSHOT_NOT_READY');
    expect(await code(port.summary(id))).toBe('ONEC_STOCK_SNAPSHOT_NOT_READY');
    port.start(id);
    port.complete(id, [row(W1.toUpperCase(), 2), row(W1, 1.5), row(W2, 4), row(null, 1)]);
    expect((await port.rows(id)).map((item) => [item.warehouseRefKey, item.itemRefKey, item.quantity])).toEqual([
      [W1, ITEM.toLowerCase(), 2], [W1, ITEM.toLowerCase(), 1.5], [W2, ITEM.toLowerCase(), 4], [null, ITEM.toLowerCase(), 1],
    ]);
    expect((await port.rows(id, { warehouseRefKeys: [W2.toUpperCase()] })).map((item) => item.quantity)).toEqual([4]);
    expect(await port.rows(id, { warehouseRefKeys: [] })).toEqual([]);
    expect(await port.summary(id)).toEqual([
      { warehouseRefKey: W1, rows: 2, quantityTotal: 3.5 }, { warehouseRefKey: W2, rows: 1, quantityTotal: 4 }, { warehouseRefKey: null, rows: 1, quantityTotal: 1 },
    ]);
    expect(await code(port.rows(404))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
  });

  it('delete: a ready or failed snapshot disappears, a waiting one is cancelled, one being read is refused', async () => {
    const port = fresh();
    const ready = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-1' }, actor, 'r');
    port.complete(ready.id, [row(W1, 1)]);
    const reading = await port.request({ momentLocal: '2026-09-27T10:14:00', idempotencyKey: 'request-2' }, actor, 'r');
    port.start(reading.id);
    const waiting = await port.request({ momentLocal: '2026-09-28T10:14:00', idempotencyKey: 'request-3' }, actor, 'r');
    expect(await code(port.delete(reading.id, actor, 'r'))).toBe('ONEC_STOCK_SNAPSHOT_IN_PROGRESS');
    await port.delete(ready.id, actor, 'r');
    await port.delete(waiting.id, actor, 'r');
    expect((await port.list()).items.map((item) => item.id)).toEqual([reading.id]);
    for (const id of [ready.id, waiting.id]) {
      expect(await code(port.get(id))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
      expect(await code(port.rows(id))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
      expect(await code(port.summary(id))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
      expect(await code(port.delete(id, actor, 'r'))).toBe('ONEC_STOCK_SNAPSHOT_NOT_FOUND');
    }
    expect(await port.get(waiting.id, { includeDeleted: true })).toMatchObject({ status: 'failed', errorCode: 'CANCELLED' });
    expect((await port.get(ready.id, { includeDeleted: true })).deletedAt).not.toBeNull();
  });

  it('a replaced 1C base: ready snapshots become historical and are not returned for the same moment; active ones fail', async () => {
    const port = fresh();
    const old = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-1' }, actor, 'r');
    port.complete(old.id, [row(W1, 1)]);
    const active = await port.request({ momentLocal: '2026-09-27T10:14:00', idempotencyKey: 'request-2' }, actor, 'r');
    const base = (await port.get(old.id)).baseRef;
    expect((await port.get(active.id)).baseRef).toBe(base);
    port.replaceBase();
    // The reference of the base never changes for a stored snapshot; snapshots of another base carry another one.
    expect(await port.get(old.id)).toMatchObject({ status: 'ready', currentSource: false, baseRef: base });
    expect(await port.get(active.id)).toMatchObject({ status: 'failed', errorCode: 'SOURCE_GENERATION_CHANGED', currentSource: false });
    const again = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-3' }, actor, 'r');
    expect(again.id).not.toBe(old.id);
    expect(again.currentSource).toBe(true);
    expect(again.baseRef).not.toBe(base);
    expect((await port.list({ currentSourceOnly: true })).items.map((item) => item.id)).toEqual([again.id]);
    expect((await port.list({ status: 'ready' })).items.map((item) => item.id)).toEqual([old.id]);
  });

  it('a snapshot over the row limit fails instead of being cut; waiting has a reason and moves updatedAt', async () => {
    let clock = Date.parse('2026-10-08T06:00:00Z');
    const port = new InMemoryOnecStockSnapshots({ now: () => new Date(clock) });
    const big = await port.request({ momentLocal: '2026-09-26T10:14:00', idempotencyKey: 'request-1' }, actor, 'r');
    clock += 1000;
    port.wait(big.id, 'AGENT_OFFLINE');
    expect(await port.get(big.id)).toMatchObject({ status: 'requested', waitReason: 'AGENT_OFFLINE', updatedAt: '2026-10-08T06:00:01.000Z' });
    port.complete(big.id, Array.from({ length: STOCK_SNAPSHOT_MAX_ROWS + 1 }, () => row(W1, 1)));
    expect(await port.get(big.id)).toMatchObject({ status: 'failed', errorCode: 'TOO_MANY_ROWS', waitReason: null });
  });
});
