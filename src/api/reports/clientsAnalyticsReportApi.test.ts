import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countClientsAnalyticsAfter, findClientAnalyticsByName } from './clientsAnalyticsReportApi';
import * as client from '../hasuraReportClient';

describe('clientsAnalyticsReportApi', () => {
  beforeEach(() => vi.spyOn(client, 'hasuraReportQuery'));
  afterEach(() => vi.restoreAllMocks());

  it('findClientAnalyticsByName queries clients_analytics_view, first row or null', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      clients_analytics_view: [{ client_id: 3, client_name: 'X' }],
    });
    expect(await findClientAnalyticsByName('X')).toMatchObject({ client_id: 3 });
    const [, vars] = (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(vars).toEqual({ clientNamePattern: '%X%' });
  });

  it('returns null when empty', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ clients_analytics_view: [] });
    expect(await findClientAnalyticsByName('zz')).toBeNull();
  });

  it('countClientsAnalyticsAfter returns aggregate count', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      clients_analytics_view_aggregate: { aggregate: { count: 11 } },
    });
    expect(await countClientsAnalyticsAfter(3)).toBe(11);
  });
});
