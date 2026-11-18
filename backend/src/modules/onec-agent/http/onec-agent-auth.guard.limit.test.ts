import { describe, expect, it } from 'vitest';
import { isBatchUpload } from './onec-agent-auth.guard';

describe('agent guard: batch upload detection (incident 12–18.11.2026)', () => {
  it('only POST …/etl/batches is an upload (not the lookup, not other routes)', () => {
    expect(isBatchUpload({ method: 'POST', originalUrl: '/api/integration/1c-agents/v1/etl/batches' })).toBe(true);
    expect(isBatchUpload({ method: 'POST', originalUrl: '/api/integration/1c-agents/v1/etl/batches/?x=1' })).toBe(true);
    expect(isBatchUpload({ method: 'GET', originalUrl: '/api/integration/1c-agents/v1/etl/batches' })).toBe(false);
    expect(isBatchUpload({ method: 'GET', originalUrl: '/api/integration/1c-agents/v1/etl/batches/abc' })).toBe(false);
    expect(isBatchUpload({ method: 'POST', originalUrl: '/api/integration/1c-agents/v1/heartbeat' })).toBe(false);
    expect(isBatchUpload({ method: 'POST', url: '/api/integration/1c-agents/v1/etl/batches' })).toBe(true);
  });
});
