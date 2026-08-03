import { describe, expect, it } from 'vitest';
import { ORDER_REALTIME_PRODUCER_MATRIX } from './order-realtime-producer-matrix';

describe('order realtime producer matrix', () => {
  it('has no unowned runtime writer or untested producer', () => {
    expect(ORDER_REALTIME_PRODUCER_MATRIX.length).toBeGreaterThanOrEqual(6);
    for (const row of ORDER_REALTIME_PRODUCER_MATRIX) {
      expect(row.writerPaths.length).toBeGreaterThan(0);
      expect(row.mutatedTables.length).toBeGreaterThan(0);
      expect(row.domains.length).toBeGreaterThan(0);
      expect(row.producer).not.toMatch(/TBD|unverified/i);
      expect(row.test).toMatch(/\.test\.ts$/);
    }
  });

  it('covers status, cut membership, result state, profile fan-out, and order visibility', () => {
    const tables = new Set(ORDER_REALTIME_PRODUCER_MATRIX.flatMap((row) => row.mutatedTables));
    expect(tables).toEqual(new Set([
      'order_details',
      'orders',
      'cut_job_item',
      'cut_job',
      'cut_result_archive_state',
      'cut_param_profiles',
    ]));
  });
});
