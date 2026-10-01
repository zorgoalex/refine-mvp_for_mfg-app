import { describe, expect, it } from 'vitest';
import { filterActivePaymentSelection, paymentReconcileAuditState } from './pg-bitrix24-reverse-repository';

describe('exact Bitrix24 payment selection', () => {
  it('materializes active rows while allowing selected deleted rows to be removed', () => {
    expect(filterActivePaymentSelection([
      { bitrix_payment_id: '101', state: 'active', paid: true },
      { bitrix_payment_id: '102', state: 'deleted', paid: false },
      { bitrix_payment_id: '103', state: 'materialized', paid: true },
    ], ['101', '102', '103'])).toEqual(['101', '103']);
  });

  it('rejects an ID outside the exact request or order selection', () => {
    expect(() => filterActivePaymentSelection([
      { bitrix_payment_id: '101', state: 'active', paid: true },
    ], ['101', '999'])).toThrow(/999/);
  });
});

describe('payment reconcile audit state', () => {
  const before = { digest: 'd1', activePaymentCount: 2, activePaymentAmount: 750.5 };

  it('marks a pass that left the stored snapshots untouched as unchanged', () => {
    expect(paymentReconcileAuditState(before, { digest: 'd1' }, [{ amount: 500 }, { amount: 250.5 }])).toEqual({
      before: { activePaymentCount: 2, activePaymentAmount: 750.5 },
      after: { activePaymentCount: 2, activePaymentAmount: 750.5 },
      metadata: { changed: false },
    });
  });

  it('marks any difference of the stored snapshots as changed, even with equal count and amount', () => {
    expect(paymentReconcileAuditState(before, { digest: 'd2' }, [{ amount: 500 }, { amount: 250.5 }])).toEqual({
      before: { activePaymentCount: 2, activePaymentAmount: 750.5 },
      after: { activePaymentCount: 2, activePaymentAmount: 750.5 },
      metadata: { changed: true },
    });
  });

  it('reports the incoming set as the state after the reconcile', () => {
    expect(paymentReconcileAuditState(before, { digest: 'd3' }, []).after).toEqual({
      activePaymentCount: 0,
      activePaymentAmount: 0,
    });
  });
});
