import { describe, expect, it } from 'vitest';
import {
  importedLineFingerprint,
  moneyText,
  normalizeBitrixProductRow,
  productOrderFingerprint,
  productRowLineTotal,
  productRowsHash,
  sumMoney,
  type Bitrix24ProductRow,
} from './bitrix24-product-rows';

function remoteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '9001',
    productId: '42',
    productName: 'Столешница',
    sort: '10',
    quantity: '1',
    price: '10000',
    discountTypeId: '1',
    discountRate: '10',
    discountSum: '9090.90909091',
    taxRate: '12',
    taxIncluded: 'Y',
    measureCode: '4',
    measureName: 'шт',
    ...overrides,
  };
}

function normalized(overrides: Record<string, unknown> = {}): Bitrix24ProductRow {
  const result = normalizeBitrixProductRow(remoteRow(overrides));
  if (!('row' in result)) throw new Error(`unexpected invalid: ${JSON.stringify(result)}`);
  return result.row;
}

describe('normalizeBitrixProductRow', () => {
  it('canonicalizes quantity/price to 3dp/2dp and keeps 8dp discount provenance', () => {
    const row = normalized();
    expect(row.quantity).toBe('1.000');
    expect(row.unitPrice).toBe('10000.00');
    expect(row.discountSum).toBe('9090.90909091');
    expect(row.taxIncluded).toBe('Y');
    expect(row.normalizedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts representable trailing zeroes (10.0000, 1.0000)', () => {
    const row = normalized({ quantity: '1.0000', price: '10.0000' });
    expect(row.quantity).toBe('1.000');
    expect(row.unitPrice).toBe('10.00');
  });

  it('rejects genuinely nonzero excess precision', () => {
    expect(normalizeBitrixProductRow(remoteRow({ quantity: '1.0005' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_PRECISION' }),
    });
    expect(normalizeBitrixProductRow(remoteRow({ price: '10.005' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_PRECISION' }),
    });
  });

  it('rejects free-text rows (productId 0) as unmapable', () => {
    expect(normalizeBitrixProductRow(remoteRow({ productId: '0' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_CUSTOM', productId: '0' }),
    });
  });

  it('canonicalizes leading-zero product IDs (00042 -> 42)', () => {
    expect(normalized({ productId: '00042' }).productId).toBe('42');
  });

  it('rejects malformed ids, non-positive quantity, and oversized totals', () => {
    expect(normalizeBitrixProductRow(remoteRow({ id: 'abc' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_SHAPE' }),
    });
    expect(normalizeBitrixProductRow(remoteRow({ quantity: '0' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_PRECISION' }),
    });
    // Price beyond 10 integer digits is a precision error by itself.
    expect(normalizeBitrixProductRow(remoteRow({ price: '10000000000' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_PRECISION' }),
    });
    // Individually representable operands whose product exceeds the ERP cap.
    expect(normalizeBitrixProductRow(remoteRow({ quantity: '999999', price: '9999999999.99' }))).toEqual({
      invalid: expect.objectContaining({ code: 'BITRIX24_PRODUCT_ROW_OVERFLOW' }),
    });
  });
});

describe('money helpers', () => {
  it('sumMoney handles signed values correctly', () => {
    expect(sumMoney(['-1.50'])).toBe('-1.50');
    expect(sumMoney(['1.50', '-1.00'])).toBe('0.50');
    expect(sumMoney(['0.10', '0.20', '-0.30'])).toBe('0.00');
  });

  it('productRowLineTotal rounds half-up to 2 decimals', () => {
    expect(productRowLineTotal('1.000', '10.00')).toBe('10.00');
    expect(productRowLineTotal('0.001', '10.00')).toBe('0.01');
    expect(productRowLineTotal('2.500', '3.33')).toBe('8.33');
  });

  it('moneyText canonicalizes to 2dp, preserving sign only for nonzero', () => {
    expect(moneyText('10000')).toBe('10000.00');
    expect(moneyText('-0.005')).toBe('-0.01');
    expect(moneyText('-0.00')).toBe('0.00');
    expect(moneyText('bogus')).toBeNull();
  });
});

describe('hashing', () => {
  it('hashes canonical values: remote "1"/"10000" equals stored "1.000"/"10000.00"', () => {
    const plain = normalized({ quantity: '1', price: '10000' });
    const padded = normalized({ quantity: '1.0000', price: '10000.0000' });
    expect(plain.normalizedHash).toBe(padded.normalizedHash);
  });

  it('productRowsHash detects a same-total row swap', () => {
    const first = normalized({ id: '1', productId: '10', price: '50' });
    const second = normalized({ id: '2', productId: '20', price: '50' });
    const swapped = normalized({ id: '3', productId: '30', price: '100' });
    expect(productRowsHash([first, second])).not.toBe(productRowsHash([swapped]));
    expect(productRowsHash([first, second])).toBe(productRowsHash([second, first]));
  });
});

describe('productOrderFingerprint', () => {
  const base = {
    rowsHash: 'a'.repeat(64),
    mappingVersions: ['9007:1', '9008:2'],
    importedLines: ['fp1', 'fp2'],
    orderFinancials: { totalAmount: '100.00', discount: '0.00', surcharge: '0.00', finalAmount: '100.00' },
  };

  it('binds mapping versions — a remap invalidates the readiness certificate', () => {
    const fp = productOrderFingerprint(base);
    expect(productOrderFingerprint({
      ...base,
      mappingVersions: ['9007:1', '9008:3'],
    })).not.toBe(fp);
    expect(productOrderFingerprint({
      ...base,
      mappingVersions: ['9008:2', '9007:1'],
    })).toBe(fp);
  });

  it('binds order financials only when present (empty remote list leaves them free)', () => {
    const fp = productOrderFingerprint(base);
    expect(productOrderFingerprint({ ...base, orderFinancials: null })).not.toBe(fp);
    expect(productOrderFingerprint({
      ...base,
      orderFinancials: { ...base.orderFinancials, finalAmount: '200.00' },
    })).not.toBe(fp);
  });
});

describe('importedLineFingerprint', () => {
  it('binds catalog version and line identity', () => {
    const input = {
      orderLineId: 55, bitrixRowId: '9001', catalogItemId: 7, catalogVersion: 3,
      quantity: '1.000', unitPrice: '10.00', lineTotal: '10.00',
    };
    expect(importedLineFingerprint(input))
      .not.toBe(importedLineFingerprint({ ...input, catalogVersion: 4 }));
    expect(importedLineFingerprint(input))
      .not.toBe(importedLineFingerprint({ ...input, orderLineId: 56 }));
  });
});
