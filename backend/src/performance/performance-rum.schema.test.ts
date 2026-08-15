import { describe, expect, it } from 'vitest';
import { parsePerformanceRumBatch } from './performance-rum.schema';

const validBatch = {
  schemaVersion: 1 as const,
  sessionNonce: '018fb47a-8a34-7bf2-924e-0242ac120002',
  configVersion: 'order-lifecycle-v1',
  buildSha: 'abcdef123456',
  cohort: 'treatment' as const,
  route: 'order-show' as const,
  dataProfile: 'warm' as const,
  orderRealtimeMode: 'connected' as const,
  measurements: [{ name: 'meaningful_ready_ms' as const, value: 742.5 }],
};

describe('performance RUM schema', () => {
  it('accepts bounded allowlisted numeric and enum fields', () => {
    expect(parsePerformanceRumBatch(validBatch)).toEqual(validBatch);
  });

  it('rejects free text, identifiers and unknown metric names', () => {
    expect(() => parsePerformanceRumBatch({ ...validBatch, orderId: 11462 })).toThrow();
    expect(() => parsePerformanceRumBatch({
      ...validBatch,
      measurements: [{ name: 'comment', value: 1 }],
    })).toThrow();
    expect(() => parsePerformanceRumBatch({ ...validBatch, configVersion: 'contains spaces' })).toThrow();
  });

  it('rejects oversized batches and non-finite values', () => {
    expect(() => parsePerformanceRumBatch({
      ...validBatch,
      measurements: Array.from({ length: 33 }, () => validBatch.measurements[0]),
    })).toThrow();
    expect(() => parsePerformanceRumBatch({
      ...validBatch,
      measurements: [{ name: 'meaningful_ready_ms', value: Number.POSITIVE_INFINITY }],
    })).toThrow();
  });
});
