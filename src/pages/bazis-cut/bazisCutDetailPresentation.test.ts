import { describe, expect, it } from 'vitest';
import {
  buildBazisCutCardPosition,
  buildBazisCutQrCode,
  summarizeBazisCutDetails,
} from './bazisCutDetailPresentation';

describe('buildBazisCutCardPosition', () => {
  it.each([
    ['BZ-100', '', '.01.00.07', 'BZ-100.01.00.07'],
    ['', 'BP-7', 'Кухня.01.00.07', 'BP-7Кухня.01.00.07'],
    ['', '', 'ERP-1491.7', 'ERP-1491.7'],
  ])('prefixes Position with the filled Basis order or Basis project',
    (order, project, position, expected) => {
      expect(buildBazisCutCardPosition({
        sourceBazisOrderNo: order,
        sourceBazisProjectName: project,
        position,
      })).toBe(expected);
    });

  it('prefers the Basis order when both provenance fields are unexpectedly filled', () => {
    expect(buildBazisCutCardPosition({
      sourceBazisOrderNo: ' BZ-100 ',
      sourceBazisProjectName: ' BP-7 ',
      position: ' .01 ',
    })).toBe('BZ-100.01');
  });
});

describe('buildBazisCutQrCode', () => {
  it.each([
    ['1319', 'Кухня.01.00.07', '1319Кухня.01.00.07'],
    ['1319', '', '1319'],
    ['', 'Кухня.01.00.07', 'Кухня.01.00.07'],
    ['', '', ''],
  ])('joins Basis project and Position values', (project, position, expected) => {
    expect(buildBazisCutQrCode({
      sourceBazisProjectName: project,
      position,
    })).toBe(expected);
  });

  it('trims values without inserting blank fragments', () => {
    expect(buildBazisCutQrCode({
      sourceBazisProjectName: ' 1319 ',
      position: ' Кухня.01.00.07 ',
    })).toBe('1319Кухня.01.00.07');
  });
});

describe('summarizeBazisCutDetails', () => {
  it('counts positions and sums quantity and finished-detail area', () => {
    const summary = summarizeBazisCutDetails([
      { quantity: 2, finishedLengthMm: 1000, finishedWidthMm: 500 },
      { quantity: 3, finishedLengthMm: 500, finishedWidthMm: 200 },
      { quantity: 1, finishedLengthMm: 1000, finishedWidthMm: 100 },
    ]);
    expect(summary).toMatchObject({
      positionCount: 3,
      quantity: 6,
    });
    expect(summary.totalAreaM2).toBeCloseTo(1.4);
  });
});
