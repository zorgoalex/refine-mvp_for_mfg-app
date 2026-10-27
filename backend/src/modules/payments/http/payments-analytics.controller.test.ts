import { describe, expect, it, vi } from 'vitest';
import { PaymentsAnalyticsController } from './payments-analytics.controller';

const user = { id: 7 };
function controller() {
  const summary = vi.fn(async () => ({ ok: true }));
  const dashboard = vi.fn(async () => ({ ok: true }));
  return { summary, dashboard, controller: new PaymentsAnalyticsController({ summary, dashboard } as never) };
}

describe('PaymentsAnalyticsController', () => {
  it('requires authentication', () => {
    expect(() => controller().controller.summary({} as never, { dateFrom: '2026-10-01', dateTo: '2026-10-05' }))
      .toThrowError(expect.objectContaining({ statusCode: 401 }));
  });

  it('passes validated filters with numbers coerced', async () => {
    const { controller: http, summary } = controller();
    await http.summary({ user, requestId: 'req-9' } as never, { dateFrom: '2026-10-01', dateTo: '2026-10-05', amountMin: '1000', clientName: ' Иван ' });
    expect(summary).toHaveBeenCalledWith(user, { dateFrom: '2026-10-01', dateTo: '2026-10-05', amountMin: 1000, clientName: 'Иван' }, 'req-9');
  });

  it.each([
    ['no period', {}],
    ['a reversed period', { dateFrom: '2026-10-05', dateTo: '2026-10-01' }],
    ['a period longer than 366 days', { dateFrom: '2025-01-01', dateTo: '2026-10-05' }],
    ['not a calendar date', { dateFrom: '2026-02-30', dateTo: '2026-03-01' }],
    ['an unknown filter', { dateFrom: '2026-10-01', dateTo: '2026-10-05', where: '1=1' }],
  ])('rejects %s', (_name, query) => {
    const { controller: http, summary } = controller();
    expect(() => http.summary({ user } as never, query)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_FAILED' }));
    expect(summary).not.toHaveBeenCalled();
  });

  it('dashboard: passes the period and rejects a bad or too long one', async () => {
    const { controller: http, dashboard } = controller();
    await http.dashboard({ user, requestId: 'req-5' } as never, { dateFrom: '2026-09-07', dateTo: '2026-10-06' });
    expect(dashboard).toHaveBeenCalledWith(user, { dateFrom: '2026-09-07', dateTo: '2026-10-06' }, 'req-5');

    for (const query of [{}, { dateFrom: '2026-01-01', dateTo: '2026-10-06' }, { dateFrom: '2026-10-06', dateTo: '2026-10-01' }, { dateFrom: '2026-10-01', dateTo: '2026-10-06', clientName: 'x' }]) {
      expect(() => http.dashboard({ user } as never, query)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'VALIDATION_FAILED' }));
    }
    expect(() => http.dashboard({} as never, { dateFrom: '2026-10-01', dateTo: '2026-10-06' })).toThrowError(expect.objectContaining({ statusCode: 401 }));
    expect(dashboard).toHaveBeenCalledTimes(1);
  });
});
