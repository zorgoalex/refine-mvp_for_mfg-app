import { describe, expect, it } from 'vitest';
import { catalogLineAmount, normalizeCatalogLineInputs, assertOrderHasPositions } from './order-catalog-lines';

describe('order catalogue lines', () => {
  it.each([['2', '1500.50', '3001.00'], ['1.5', '0.01', '0.02'], ['1', '0', '0.00'], ['0.001', '9999999.99', '10000.00']])('rounds %s × %s exactly', (qty, price, expected) => {
    expect(catalogLineAmount(qty, price)).toBe(expected);
  });
  it.each([['0', '1'], ['-1', '1'], ['1.0001', '1'], ['1', '-1'], ['1', '0.001'], ['1e2', '1'], ['Infinity', '1'], ['2', '9999999999.99']])('rejects invalid/overflow amounts %s × %s', (qty, price) => {
    expect(() => catalogLineAmount(qty, price)).toThrow();
  });
  it('does not default missing prices to zero', () => {
    expect(() => normalizeCatalogLineInputs([{ clientKey: 'new-1', catalogItemId: 1, catalogVersion: 1, quantity: '1' }])).toThrow();
  });
  it('rejects duplicate ids and malformed input', () => {
    const row = { id: 1, catalogItemId: 1, quantity: '1', unitPrice: '10' };
    expect(() => normalizeCatalogLineInputs([row, row])).toThrow();
    expect(() => normalizeCatalogLineInputs({})).toThrow();
    expect(() => normalizeCatalogLineInputs([null])).toThrow();
  });
  it('distinguishes omitted catalogue input from an empty list', () => {
    expect(normalizeCatalogLineInputs(undefined)).toBeUndefined();
    expect(normalizeCatalogLineInputs([])).toEqual([]);
  });
  it('allows details-only, goods-only and mixed but rejects empty orders', () => {
    expect(() => assertOrderHasPositions(1, 0)).not.toThrow();
    expect(() => assertOrderHasPositions(0, 1)).not.toThrow();
    expect(() => assertOrderHasPositions(1, 1)).not.toThrow();
    expect(() => assertOrderHasPositions(0, 0)).toThrow('Добавьте хотя бы одну деталь или позицию товаров/услуг');
  });
});
