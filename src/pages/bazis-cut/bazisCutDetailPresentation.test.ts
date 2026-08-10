import { describe, expect, it } from 'vitest';
import {
  buildBazisCutCardPosition,
  buildBazisCutQrCode,
  formatBazisCutAreaM2,
  summarizeBazisCutDetails,
} from './bazisCutDetailPresentation';

describe('buildBazisCutCardPosition', () => {
  it.each([
    ['BZ-100', '', '01.00.07', '01.00.07'],
    ['', 'BP-7', '01.00.07', '01.00.07'],
    ['', '', '7', '7'],
  ])('shows the frozen Position field without a hidden prefix',
    (order, project, position, expected) => {
      expect(buildBazisCutCardPosition({
        sourceBazisOrderNo: order,
        sourceBazisProjectName: project,
        position,
      })).toBe(expected);
    });

  it('trims the frozen Position value', () => {
    expect(buildBazisCutCardPosition({
      sourceBazisOrderNo: ' BZ-100 ',
      sourceBazisProjectName: ' BP-7 ',
      position: ' .01 ',
    })).toBe('.01');
  });
});

describe('buildBazisCutQrCode', () => {
  it.each([
    ['1319', '', 'ERP-1491', 'Кухня', '01.00.07', '1319Кухня.01.00.07'],
    ['', '1320', 'ERP-1491', '', '01.00.07', '1320.01.00.07'],
    ['1319', '1320', 'ERP-1491', '', '01.00.07', '1319.01.00.07'],
    ['', '', 'ERP-1491', '', '7', 'ERP-1491.7'],
    ['', '', '', '', '7', '.7'],
  ])('joins Basis project/order/source, optional product, dot, and Position', (project, order, sourceOrderName, product, position, expected) => {
    expect(buildBazisCutQrCode({
      sourceBazisProjectName: project,
      sourceBazisOrderNo: order,
      sourceOrderName,
      sourceBazisProductName: product,
      position,
    })).toBe(expected);
  });

  it('trims values without inserting blank fragments', () => {
    expect(buildBazisCutQrCode({
      sourceBazisProjectName: ' 1319 ',
      sourceBazisOrderNo: ' 1320 ',
      sourceOrderName: ' ERP-1491 ',
      sourceBazisProductName: ' Кухня ',
      position: ' 01.00.07 ',
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
