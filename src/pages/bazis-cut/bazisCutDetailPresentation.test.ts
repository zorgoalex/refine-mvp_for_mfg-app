import { describe, expect, it } from 'vitest';
import { buildBazisCutQrCode, summarizeBazisCutDetails } from './bazisCutDetailPresentation';

describe('buildBazisCutQrCode', () => {
  it.each([
    ['1319', 'Кухня', '01.00.07', '1319Кухня.01.00.07'],
    ['1319', '', '01.00.07', '1319.01.00.07'],
    ['', 'Кухня', '01.00.07', 'Кухня.01.00.07'],
    ['', '', '01.00.07', '01.00.07'],
    ['1319', 'Кухня', '', '1319Кухня'],
    ['', '', '', ''],
  ])('joins available Order, Product, and Position values', (order, product, position, expected) => {
    expect(buildBazisCutQrCode({
      sourceBazisOrderNo: order,
      sourceBazisProductName: product,
      position,
    })).toBe(expected);
  });

  it('trims values without inserting blank fragments', () => {
    expect(buildBazisCutQrCode({
      sourceBazisOrderNo: ' 1319 ',
      sourceBazisProductName: ' Кухня ',
      position: ' 01.00.07 ',
    })).toBe('1319Кухня.01.00.07');
  });
});

describe('summarizeBazisCutDetails', () => {
  it('counts positions and sums Quantity', () => {
    expect(summarizeBazisCutDetails([{ quantity: 2 }, { quantity: 3 }, { quantity: 1 }])).toEqual({
      positionCount: 3,
      quantity: 6,
    });
  });
});
