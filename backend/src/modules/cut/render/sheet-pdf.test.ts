import { afterEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { buildSheetsPdf } from './sheet-pdf';

const SVG = (label: string) =>
  `<svg viewBox="0 0 2800 2070"><rect x="0" y="0" width="2800" height="2070" fill="#fff"/><text x="100" y="100">${label}</text></svg>`;

describe('buildSheetsPdf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('renders bath template header fields with unique per-sheet values', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('bath'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        meta: {
          orders: ['1001', '1002'],
          clients: ['Client A', 'Client B'],
          dates: ['2026-07-02'],
          readyDates: ['2026-07-09'],
          materials: ['МДФ 16'],
          thicknesses: ['16'],
          films: ['Белая', 'Матовая'],
        },
        detailRows: [
          { position: 1, lengthMm: 898, widthMm: 548, quantity: 2 },
          { position: 2, lengthMm: 378, widthMm: 598, quantity: 1 },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('Клиент:');
    expect(rendered).toContain('Client A, Client B');
    expect(rendered).toContain('Пленка:');
    expect(rendered).toContain('Белая, Матовая');
    expect(rendered).toContain('Детали');
  });
});
