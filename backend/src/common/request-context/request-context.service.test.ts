import { describe, expect, it } from 'vitest';
import { normalizeRequestRoute, RequestContextService } from './request-context.service';

describe('RequestContextService', () => {
  it('keeps correlation context across async work', async () => {
    const contexts = new RequestContextService();

    const value = await contexts.run(
      { requestId: 'req-test', method: 'GET', route: '/api/v1/orders/:id' },
      async () => {
        await Promise.resolve();
        return contexts.get();
      },
    );

    expect(value).toEqual({
      requestId: 'req-test',
      method: 'GET',
      route: '/api/v1/orders/:id',
    });
    expect(contexts.get()).toBeUndefined();
  });

  it('keeps only a bounded resource prefix and removes every possible path identifier', () => {
    expect(normalizeRequestRoute('/api/v1/orders/11462?includeDeleted=true')).toBe(
      '/api/v1/orders/*',
    );
    expect(normalizeRequestRoute('/api/v1/jobs/018fb47a-8a34-7bf2-924e-0242ac120002')).toBe(
      '/api/v1/jobs/*',
    );
    expect(normalizeRequestRoute('/api/v1/cnc-telegram/media/tg_100_10847.jpg')).toBe(
      '/api/v1/cnc-telegram/*',
    );
    expect(normalizeRequestRoute('/api/v1/cut/settings/customer-secret')).toBe('/api/v1/cut/*');
    expect(normalizeRequestRoute('/health/live')).toBe('/health/*');
  });
});
