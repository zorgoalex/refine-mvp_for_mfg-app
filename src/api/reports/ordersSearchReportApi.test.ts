import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countOrdersAfter, findOrderByName } from './ordersSearchReportApi';
import * as client from '../hasuraReportClient';

describe('ordersSearchReportApi', () => {
  beforeEach(() => vi.spyOn(client, 'hasuraReportQuery'));
  afterEach(() => vi.restoreAllMocks());

  it('findOrderByName queries orders_view and returns the first row or null', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      orders_view: [{ order_id: 5, order_name: '100', order_name_numeric: 100, order_date: '2026-06-01' }],
    });
    const row = await findOrderByName('100');
    expect(row).toMatchObject({ order_id: 5 });
    const [, vars] = (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(vars).toEqual({ orderNamePattern: '%100%' });
  });

  it('findOrderByName returns null when no rows', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ orders_view: [] });
    expect(await findOrderByName('zzz')).toBeNull();
  });

  it('countOrdersAfter returns the aggregate count', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      orders_view_aggregate: { aggregate: { count: 42 } },
    });
    expect(await countOrdersAfter({ orderDate: '2026-06-01', orderNameNumeric: 100 })).toBe(42);
  });
});
