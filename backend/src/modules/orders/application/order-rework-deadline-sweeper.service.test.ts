import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { OrderReworkDeadlineSweeper } from './order-rework-deadline-sweeper.service';

// «Переделка» 1.1 §6.3 — the background pass of the final-deadline reconciliation (review R2.1, R2.2).
function queue(rows: (excluded: number[]) => Array<{ order_id: number; round_id: number }>, failFirst = 0) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let failures = failFirst;
  const database = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (failures > 0) {
        failures -= 1;
        throw new Error('connection terminated');
      }
      return { rows: rows((params[2] as number[]) ?? []) };
    },
  } as unknown as DatabaseService;
  return { database, calls };
}

describe('OrderReworkDeadlineSweeper', () => {
  it('a failed queue read never rejects; the next pass works', async () => {
    const { database } = queue(() => [{ order_id: 7, round_id: 70 }], 1);
    const done: number[] = [];
    const sweeper = new OrderReworkDeadlineSweeper({ database, enabled: () => true, reconcile: async ({ orderId }) => { done.push(orderId); } });
    await expect(sweeper.sweep(new Date('2026-10-27T10:00:00Z'))).resolves.toBe(0);
    await expect(sweeper.sweep(new Date('2026-10-27T10:00:30Z'))).resolves.toBe(1);
    expect(done).toEqual([7]);
  });

  it('orders that keep failing back off, so the rest of the queue (the 21st) is still served', async () => {
    const all = Array.from({ length: 21 }, (_, i) => ({ order_id: i + 1, round_id: 100 + i }));
    // As the SQL: oldest first, minus backed-off orders, at most 20.
    const { database, calls } = queue((excluded) => all.filter((row) => !excluded.includes(row.order_id)).slice(0, 20));
    const reconciled: number[] = [];
    const sweeper = new OrderReworkDeadlineSweeper({
      database,
      enabled: () => true,
      reconcile: async ({ orderId, context }) => {
        expect(context).toEqual({ fromSnapshotMarks: true });
        if (orderId <= 20) throw new Error('deadline row locked');
        reconciled.push(orderId);
      },
    });
    const t0 = new Date('2026-10-27T10:00:00Z').getTime();
    expect(await sweeper.sweep(new Date(t0))).toBe(0);
    expect(await sweeper.sweep(new Date(t0 + 1_000))).toBe(1);
    expect(reconciled).toEqual([21]);
    expect((calls[1].params[2] as number[]).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // After the backoff the failing orders are tried again (30 s after the first failure).
    await sweeper.sweep(new Date(t0 + 31_000));
    expect(calls[2].params[2]).toEqual([]);
  });

  it('the queue skips deleted orders and takes the oldest marks first', async () => {
    const { database, calls } = queue(() => []);
    const sweeper = new OrderReworkDeadlineSweeper({ database, enabled: () => true, reconcile: async () => undefined });
    await sweeper.sweep(new Date('2026-10-27T10:00:00Z'));
    const sql = calls[0].text.replace(/\s+/g, ' ');
    expect(sql).toContain('COALESCE(o.delete_flag, false) = false');
    expect(sql).toContain('ORDER BY deadline_sync_requested_at, order_id');
  });
});
