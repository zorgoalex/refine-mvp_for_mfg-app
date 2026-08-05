import { describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import { PgOrderRealtimeWriter } from './pg-order-realtime-writer';

describe('PgOrderRealtimeWriter', () => {
  it('locks distinct order streams in ascending order', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = fakeTx((text, params) => {
      queries.push({ text, params });
      return { rows: [] };
    });

    await new PgOrderRealtimeWriter().lockOrderStreams(tx, [9, 2, 9]);

    expect(queries).toHaveLength(2);
    expect(queries[0].params[0]).toEqual([2, 9]);
    expect(queries[1].text).toMatch(/ORDER BY order_id[\s\S]*FOR UPDATE/i);
  });

  it('increments affected counters, persists the event, and notifies in one transaction', async () => {
    const queries: string[] = [];
    const tx = fakeTx((text) => {
      queries.push(text);
      if (/FROM realtime_event_log/i.test(text)) return { rows: [] };
      if (/UPDATE order_realtime_stream/i.test(text)) {
        return { rows: [{ order_id: 7, commit_sequence: 4, detail_status_revision: 3, cut_refs_revision: 8 }] };
      }
      if (/INSERT INTO realtime_event_log/i.test(text)) {
        return {
          rows: [{
            order_id: 7,
            commit_sequence: 4,
            detail_status_revision: 3,
            cut_refs_revision: null,
            domains: ['detail_status'],
            detail_ids: [70],
            occurred_at: new Date('2026-08-03T00:00:00.000Z'),
          }],
        };
      }
      return { rows: [] };
    });

    const event = await new PgOrderRealtimeWriter().appendLocked(tx, {
      orderId: 7,
      domains: ['detail_status'],
      detailIds: [70],
      sourceType: 'production-action',
      sourceKey: 'command:1',
    });

    expect(event).toMatchObject({ commitSequence: 4, detailStatusRevision: 3, cutRefsRevision: null });
    expect(queries.some((text) => /pg_notify\('erp_realtime'/i.test(text))).toBe(true);
  });

  it('returns an existing source event without incrementing counters', async () => {
    const queries: string[] = [];
    const tx = fakeTx((text) => {
      queries.push(text);
      return {
        rows: [{
          order_id: 7,
          commit_sequence: 2,
          detail_status_revision: 2,
          cut_refs_revision: null,
          domains: ['detail_status'],
          detail_ids: null,
          occurred_at: new Date('2026-08-03T00:00:00.000Z'),
        }],
      };
    });

    await new PgOrderRealtimeWriter().appendLocked(tx, {
      orderId: 7,
      domains: ['detail_status'],
      sourceType: 'production-action',
      sourceKey: 'command:1',
    });

    expect(queries).toHaveLength(1);
  });
});

function fakeTx(
  query: (text: string, params: readonly unknown[]) => { rows: any[] },
): TransactionClient {
  return {
    raw: {} as TransactionClient['raw'],
    query: async (text, params = []) => query(text, params) as any,
  };
}
