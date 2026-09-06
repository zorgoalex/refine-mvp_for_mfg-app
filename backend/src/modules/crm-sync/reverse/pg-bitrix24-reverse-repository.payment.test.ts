import { describe, expect, it } from 'vitest';
import { filterActivePaymentSelection } from './pg-bitrix24-reverse-repository';

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
