import { describe, expect, it, vi } from 'vitest';
import { PgOrderRealtimeReader } from './pg-order-realtime-reader';

describe('PgOrderRealtimeReader replay bounds', () => {
  it('queries one row past the cap and reports overflow without returning events', async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          high_watermark: 3,
          detail_status_revision: 3,
          cut_refs_revision: 2,
          earliest_detail_status_revision: 1,
          earliest_cut_refs_revision: 1,
          events: [1, 2, 3].map((commitSequence) => ({
            order_id: 42,
            commit_sequence: commitSequence,
            detail_status_revision: commitSequence,
            cut_refs_revision: commitSequence <= 2 ? commitSequence : null,
            domains: ['detail_status'],
            detail_ids: [7],
            occurred_at: '2026-08-03T00:00:00.000Z',
          })),
        }],
      }),
    };
    const reader = new PgOrderRealtimeReader(database as never);

    const replay = await reader.loadReplay(
      42,
      { schemaVersion: 1, detailStatusRevision: 0, cutRefsRevision: 0 },
      true,
      2,
    );

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $4'),
      [42, 0, 0, 3],
    );
    expect(replay.overflow).toBe(true);
    expect(replay.events).toEqual([]);
    expect(replay.currentCursor).toEqual({
      schemaVersion: 1,
      detailStatusRevision: 3,
      cutRefsRevision: 2,
    });
  });
});

describe('PgOrderRealtimeReader snapshot', () => {
  it.each([true, false])('reads the order version with the detail stages (cut refs: %s)', async (cutRefsAllowed) => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{ order_version: '9', commit_sequence: 4, detail_status_revision: 3, cut_refs_revision: 2, details: [] }],
      }),
    };
    const reader = new PgOrderRealtimeReader(database as never);

    const snapshot = await reader.loadSnapshot(42, cutRefsAllowed);

    expect(snapshot.orderVersion).toBe(9);
    const sql = String(database.query.mock.calls[0][0]);
    expect(sql).toContain('o.version AS order_version');
    expect(sql).toContain('GROUP BY s.commit_sequence, s.detail_status_revision, s.cut_refs_revision, s.order_version');
  });
});
