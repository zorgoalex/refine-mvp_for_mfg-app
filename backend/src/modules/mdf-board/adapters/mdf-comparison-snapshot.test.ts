import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { discoverMdfComparisonScope } from './mdf-comparison-snapshot';

describe('bounded independent MDF ownership closure', () => {
  it('follows mixed-source owners transitively including invisible sources', async () => {
    let round = 0;
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toContain('snapshot_job');
      expect(sql).not.toContain('mdf_board_hidden_at IS NULL');
      expect(sql).toContain('LIMIT $2');
      if (sql.includes('SELECT DISTINCT order_id')) return { rows: (round++ ? [1,2,3] : [1,2]).map(n => ({ order_id: String(n) })) };
      return { rows: [{ kind: 'packet', id: 'p' }, { kind: 'bath', id: 'old-hidden' }] };
    });
    const result = await discoverMdfComparisonScope({ query } as unknown as DatabaseClient, { kind: 'packet', id: 'p' });
    expect(result.ownerIds).toEqual([1,2,3]); expect(query.mock.calls.length).toBe(6);
  });
  it('rejects owner sentinel before loading any source details', async () => {
    const query = vi.fn(async () => ({ rows: Array.from({ length: 101 }, (_,i) => ({ order_id: String(i+1) })) }));
    await expect(discoverMdfComparisonScope({ query } as unknown as DatabaseClient, { kind: 'packet', id: 'p' }))
      .rejects.toMatchObject({ code: 'OWNER_LIMIT' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects source sentinel and unresolved owners rather than truncating', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT DISTINCT order_id') ? [{ order_id: '1' }]
      : Array.from({ length: 251 }, (_,i) => ({ kind: 'packet', id: String(i) })) }));
    await expect(discoverMdfComparisonScope({ query } as unknown as DatabaseClient, { kind: 'packet', id: 'p' }))
      .rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
    await expect(discoverMdfComparisonScope({ query: async () => ({ rows: [] }) } as unknown as DatabaseClient,
      { kind: 'packet', id: 'p' })).rejects.toMatchObject({ code: 'UNRESOLVED_OWNERS' });
  });
});
