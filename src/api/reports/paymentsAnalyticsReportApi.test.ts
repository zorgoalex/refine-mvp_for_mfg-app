import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countPaymentsAfter, findPaymentByOrderName } from './paymentsAnalyticsReportApi';
import * as client from '../hasuraReportClient';

describe('paymentsAnalyticsReportApi', () => {
  beforeEach(() => vi.spyOn(client, 'hasuraReportQuery'));
  afterEach(() => vi.restoreAllMocks());

  it('findPaymentByOrderName queries payments_view, first row or null', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      payments_view: [{ payment_id: 2, payment_date: '2026-06-01', order_name: '100', payment_sequence_number: 1 }],
    });
    expect(await findPaymentByOrderName('100')).toMatchObject({ payment_id: 2 });
    const [, vars] = (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(vars).toEqual({ orderNamePattern: '%100%' });
  });

  it('returns null when empty', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ payments_view: [] });
    expect(await findPaymentByOrderName('zz')).toBeNull();
  });

  it('countPaymentsAfter returns aggregate count', async () => {
    (client.hasuraReportQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      payments_view_aggregate: { aggregate: { count: 5 } },
    });
    expect(await countPaymentsAfter({ paymentDate: '2026-06-01', orderName: '100', seqNum: 1 })).toBe(5);
  });
});
