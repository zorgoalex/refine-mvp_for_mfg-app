import { describe, expect, it } from 'vitest';
import { documentStateLabel, formatMoney, isRefund, onecDocKindLabel, otherCurrencyLabel, settlementTone } from './onecCustomerOrders';

describe('1C customer orders helpers', () => {
  it('labels ERP kinds and falls back to the 1C type without the Document_ prefix', () => {
    expect(onecDocKindLabel('bank_receipt')).toBe('Поступление на счёт');
    expect(onecDocKindLabel('cash_refund')).toBe('Возврат из кассы');
    expect(onecDocKindLabel(null, 'Document_СчетНаОплату')).toBe('СчетНаОплату');
    expect(onecDocKindLabel(null)).toBe('—');
    expect(isRefund('bank_refund')).toBe(true);
    expect(isRefund('bank_receipt')).toBe(false);
  });

  it('formats NUMERIC strings as money and keeps a dash for empty values', () => {
    expect(formatMoney('1234.5', 'KZT')).toMatch(/^1\s234,50 KZT$/);
    expect(formatMoney('0.00')).toBe('0,00');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('abc')).toBe('abc');
  });

  it('settlement tone: none, partial, full (kopeck tolerance), over the order sum', () => {
    expect(settlementTone('0.00', '1000.00')).toBe('none');
    expect(settlementTone('-100.00', '1000.00')).toBe('none');
    expect(settlementTone('400.00', '1000.00')).toBe('partial');
    expect(settlementTone('999.999', '1000.00')).toBe('full');
    expect(settlementTone('1000.00', '1000.00')).toBe('full');
    expect(settlementTone('1200.00', '1000.00')).toBe('over');
    expect(settlementTone('10.00', null)).toBe('over');
  });

  it('document state: missing beats deleted beats unposted; live is null', () => {
    expect(documentStateLabel({ posted: false, deletedInOnec: true, missingInSource: true })).toBe('нет в выгрузке 1С');
    expect(documentStateLabel({ posted: false, deletedInOnec: true, missingInSource: false })).toBe('помечен на удаление');
    expect(documentStateLabel({ posted: false, deletedInOnec: false, missingInSource: false })).toBe('не проведён');
    expect(documentStateLabel({ posted: true, deletedInOnec: false, missingInSource: false })).toBeNull();
  });

  it('other currencies: paid and shipped per currency, empty or zero → null', () => {
    expect(otherCurrencyLabel([])).toBeNull();
    expect(otherCurrencyLabel([{ currency: 'USD', paid: '0', shipped: '0' }])).toBeNull();
    expect(otherCurrencyLabel([{ currency: 'USD', paid: '100', shipped: '0' }, { currency: 'EUR', paid: '0', shipped: '5' }]))
      .toBe('+ 100,00 USD оплачено, 5,00 EUR отгружено');
  });
});
