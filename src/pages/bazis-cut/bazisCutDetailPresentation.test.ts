import { describe, expect, it } from 'vitest';
import { buildBazisCutQrCode, summarizeBazisCutDetails } from './bazisCutDetailPresentation';

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
