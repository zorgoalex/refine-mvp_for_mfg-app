import { describe, expect, it } from 'vitest';
import {
  createPerformanceRumBodyParser,
  createPerformanceRumFormBodyParser,
  PERFORMANCE_RUM_BODY_LIMIT_BYTES,
  performanceRumBodyPath,
} from './performance-rum-body-parser';

describe('performance RUM body parser', () => {
  it('mounts a small parser on the configured versioned API route', () => {
    expect(PERFORMANCE_RUM_BODY_LIMIT_BYTES).toBe(16 * 1024);
    expect(performanceRumBodyPath('/api/v1')).toBe('/api/v1/performance/rum');
    expect(performanceRumBodyPath('api/v2/')).toBe('/api/v2/performance/rum');
    expect(createPerformanceRumBodyParser()).toBeTypeOf('function');
    expect(createPerformanceRumFormBodyParser()).toBeTypeOf('function');
  });
});
