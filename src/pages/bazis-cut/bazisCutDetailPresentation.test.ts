import { describe, expect, it } from 'vitest';
import { buildBazisCutQrCode, formatBazisCutAreaM2, summarizeBazisCutDetails } from './bazisCutDetailPresentation';

describe('buildBazisCutQrCode', () => {
  it.each([
    ['1319', 'Кухня.01.00.07', '1319Кухня.01.00.07'],
    ['1319', '', '1319'],
    ['', 'Кухня.01.00.07', 'Кухня.01.00.07'],
    ['', '', ''],
  ])('joins Order and Position values', (order, position, expected) => {
    expect(buildBazisCutQrCode({
      sourceBazisOrderNo: order,
      position,
    })).toBe(expected);
  });

  it('trims values without inserting blank fragments', () => {
    expect(buildBazisCutQrCode({
      sourceBazisOrderNo: ' 1319 ',
      position: ' Кухня.01.00.07 ',
    })).toBe('1319Кухня.01.00.07');
  });
});

describe('summarizeBazisCutDetails', () => {
  it('counts positions and sums quantity and finished area', () => {
    expect(summarizeBazisCutDetails([
      { finishedLengthMm: 411, finishedWidthMm: 100, quantity: 2 },
      { finishedLengthMm: 1000, finishedWidthMm: 500, quantity: 3 },
      { finishedLengthMm: 200, finishedWidthMm: 50, quantity: 1 },
    ])).toEqual({
      positionCount: 3,
      quantity: 6,
      totalAreaM2: 1.5922,
    });
  });

  it('formats area with two decimal places for compact tables', () => {
    expect(formatBazisCutAreaM2(1.5922)).toBe('1,59');
  });
});
