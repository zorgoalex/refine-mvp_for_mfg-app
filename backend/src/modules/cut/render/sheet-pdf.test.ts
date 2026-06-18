import { describe, expect, it } from 'vitest';
import { buildSheetsPdf } from './sheet-pdf';

const SVG = (label: string) =>
  `<svg viewBox="0 0 2800 2070"><rect x="0" y="0" width="2800" height="2070" fill="#fff"/><text x="100" y="100">${label}</text></svg>`;

describe('buildSheetsPdf', () => {
  it('produces a PDF buffer (one page per sheet)', async () => {
    const pdf = await buildSheetsPdf([
      { svg: SVG('A'), sheetWidthMm: 2800, sheetHeightMm: 2070 },
      { svg: SVG('B'), sheetWidthMm: 2070, sheetHeightMm: 2800 },
    ]);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // One /MediaBox per page.
    const mediaBoxes = pdf.toString('latin1').match(/\/MediaBox/g) ?? [];
    expect(mediaBoxes.length).toBe(2);
  });

  it('renders a single-page PDF for one sheet', async () => {
    const pdf = await buildSheetsPdf([{ svg: SVG('only'), sheetWidthMm: 2800, sheetHeightMm: 2070 }]);
    const mediaBoxes = pdf.toString('latin1').match(/\/MediaBox/g) ?? [];
    expect(mediaBoxes.length).toBe(1);
  });

  it('rejects when there are no sheets to render', async () => {
    await expect(buildSheetsPdf([])).rejects.toThrow();
  });
});
