import { describe, expect, it, vi } from 'vitest';
import { ClientsAnalyticsController } from './clients-analytics.controller';

const user = { id: '7' };
function controller() {
  const dashboard = vi.fn(async () => ({ ok: true }));
  const card = vi.fn(async () => ({ ok: true }));
  return { dashboard, card, controller: new ClientsAnalyticsController({ dashboard, card } as never) };
}

describe('ClientsAnalyticsController', () => {
  it('requires authentication', () => {
    const { controller: http } = controller();
    expect(() => http.dashboard({} as never, { dateFrom: '2026-10-01', dateTo: '2026-10-06' })).toThrowError(expect.objectContaining({ statusCode: 401 }));
    expect(() => http.card({} as never, '5')).toThrowError(expect.objectContaining({ statusCode: 401 }));
  });

  it('passes the validated period and person type', async () => {
    const { controller: http, dashboard } = controller();
    await http.dashboard({ user, requestId: 'req-1' } as never, { dateFrom: '2026-09-07', dateTo: '2026-10-06', personType: 'legal' });
    expect(dashboard).toHaveBeenCalledWith(user, { dateFrom: '2026-09-07', dateTo: '2026-10-06', personType: 'legal' }, 'req-1');
  });

  it.each([
    ['no period', {}],
    ['a reversed period', { dateFrom: '2026-10-06', dateTo: '2026-10-01' }],
    ['a period longer than 366 days', { dateFrom: '2025-01-01', dateTo: '2026-10-06' }],
    ['an unknown person type', { dateFrom: '2026-10-01', dateTo: '2026-10-06', personType: 'robot' }],
    ['an unknown parameter', { dateFrom: '2026-10-01', dateTo: '2026-10-06', managerId: '1' }],
  ])('rejects %s', (_name, query) => {
    const { controller: http, dashboard } = controller();
    expect(() => http.dashboard({ user } as never, query)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_FAILED' }));
    expect(dashboard).not.toHaveBeenCalled();
  });

  it('opens a card by a numeric id only', async () => {
    const { controller: http, card } = controller();
    await http.card({ user, requestId: 'req-2' } as never, '5');
    expect(card).toHaveBeenCalledWith(user, 5, 'req-2');
    for (const value of ['0', '-1', 'abc', '5;drop', '']) {
      expect(() => http.card({ user } as never, value)).toThrowError(expect.objectContaining({ statusCode: 404, code: 'CLIENT_NOT_FOUND' }));
    }
    expect(card).toHaveBeenCalledTimes(1);
  });
});
