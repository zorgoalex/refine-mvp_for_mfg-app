import { afterEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { buildSheetsPdf } from './sheet-pdf';
import { FONT_FAMILY } from './sheet-png';

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
    const fontSpy = vi.spyOn(PDFDocument.prototype, 'font');
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
          { order: '1001', position: 1, lengthMm: 898, widthMm: 548, quantity: 2 },
          { order: '1002', position: 2, lengthMm: 378, widthMm: 598, quantity: 1 },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(fontSpy).toHaveBeenCalledWith(FONT_FAMILY);
    expect(rendered).toContain('Клиент:');
    expect(rendered).toContain('Client A, Client B');
    expect(rendered).toContain('Пленка:');
    expect(rendered).toContain('Белая, Матовая');
    expect(rendered).toContain('Детали');
    expect(rendered).toContain('#');
    expect(rendered).toContain('Заказ');
    expect(rendered).toContain('Поз.');
    expect(rendered).toContain('1001');
    expect(rendered).toContain('Итого: 3');
  });

  it('renders bath header values as one field text call instead of continued fragments', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    const fontSizeSpy = vi.spyOn(PDFDocument.prototype, 'fontSize');
    await buildSheetsPdf([
      {
        svg: SVG('bath-nowrap'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        meta: {
          orders: ['2556'],
          clients: ['Тлек Бакенов'],
          dates: ['2026-06-15'],
          readyDates: ['2026-06-20'],
          materials: ['МДФ 18мм -', 'МДФ 16мм'],
          thicknesses: ['18', '16'],
          films: ['Крем брюле -Декор+'],
        },
      },
    ]);

    const continuedCalls = textSpy.mock.calls.filter(
      (call) =>
        (call[2] as PDFKit.Mixins.TextOptions | undefined)?.continued ||
        (call[3] as PDFKit.Mixins.TextOptions | undefined)?.continued,
    );
    const clientValueCall = textSpy.mock.calls.find((call) => call[0] === ' Тлек Бакенов');

    expect(continuedCalls).toHaveLength(0);
    expect(clientValueCall?.[1]).toBeTypeOf('number');
    expect(clientValueCall?.[2]).toBeTypeOf('number');
    expect(clientValueCall?.[3]).toMatchObject({ width: expect.any(Number) });
    expect(fontSizeSpy).toHaveBeenCalledWith(10.5);
  });

  it('renders bath film values across the full header row before wrapping', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('bath-film-wide'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        meta: {
          films: ['Крем брюле -Декор+', 'Белый глянец', 'Олива софт -МС групп'],
        },
      },
    ]);

    const filmValueCall = textSpy.mock.calls.find((call) =>
      String(call[0]).includes('Крем брюле -Декор+, Белый глянец, Олива софт -МС групп'),
    );

    expect(filmValueCall?.[0]).toBe(' Крем брюле -Декор+, Белый глянец, Олива софт -МС групп');
    expect((filmValueCall?.[3] as PDFKit.Mixins.TextOptions | undefined)?.width).toBeGreaterThan(600);
    expect((filmValueCall?.[3] as PDFKit.Mixins.TextOptions | undefined)?.lineBreak).toBe(true);
  });

  it('uses landscape pages for portrait standard sheets', async () => {
    const pdf = await buildSheetsPdf([{ svg: SVG('portrait'), sheetWidthMm: 2070, sheetHeightMm: 2800 }]);

    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(pdf.toString('latin1'));
    expect(mediaBox).not.toBeNull();
    expect(Number(mediaBox?.[1])).toBeGreaterThan(Number(mediaBox?.[2]));
  });

  it('uses landscape pages for bath profile sheets', async () => {
    const pdf = await buildSheetsPdf([
      { svg: SVG('bath-landscape'), sheetWidthMm: 2070, sheetHeightMm: 2800, template: 'bath_profiles' },
    ]);

    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(pdf.toString('latin1'));
    expect(mediaBox).not.toBeNull();
    expect(Number(mediaBox?.[1])).toBeGreaterThan(Number(mediaBox?.[2]));
  });

  it('prints the sheet number above the bath details table', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('bath-sheet-no'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        sheetNumber: 3,
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('Лист 3');
  });

  it('keeps bath detail table cells on one line with fitted font', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('bath-table-nowrap'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        detailRows: [{ order: 'импорт 68', position: 30, lengthMm: 2702, widthMm: 52, quantity: 1 }],
      },
    ]);

    const orderCall = textSpy.mock.calls.find((call) => call[0] === 'импорт 68');
    expect(orderCall?.[3]).toMatchObject({ lineBreak: false, align: 'center' });
  });

  it('numbers bath detail table rows and prints total detail quantity', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('bath-table-numbers'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        detailRows: [
          { order: '1001', position: 1, lengthMm: 898, widthMm: 548, quantity: 2 },
          { order: '1002', position: 2, lengthMm: 378, widthMm: 598, quantity: 3 },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('#');
    expect(rendered).toContain('1');
    expect(rendered).toContain('2');
    expect(rendered).toContain('Итого: 5');
  });

  it('renders v3 template text inside bounded wrapping boxes', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    const longText = 'Очень длинный заголовок заказа, который должен переноситься внутри своего поля';
    await buildSheetsPdf([
      {
        svg: SVG('v3-text'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          elements: [
            { id: 't', type: 'text', text: longText, x: 10, y: 10, w: 45, h: 12, style: { fontSize: 10 } },
          ],
        },
      },
    ]);

    const call = textSpy.mock.calls.find((entry) => entry[0] === longText);
    expect(call?.[3]).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
      lineBreak: true,
      ellipsis: true,
    });
  });

  it('renders v3 detail tables with configured columns sorted by order', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('v3-table'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          elements: [
            {
              id: 'table',
              type: 'detail_table',
              x: 10,
              y: 20,
              w: 80,
              h: 45,
              style: {
                sort: { field: 'detail.order', direction: 'asc' },
                columns: [
                  { field: 'detail.order', label: 'Заказ', width: 2, visible: true },
                  { field: 'detail.quantity', label: 'Кол-во', width: 1, visible: true },
                ],
              },
            },
          ],
        },
        detailRows: [
          { order: '2002', position: 2, lengthMm: 300, widthMm: 100, quantity: 1 },
          { order: '1001', position: 1, lengthMm: 500, widthMm: 200, quantity: 3 },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('Заказ');
    expect(rendered).toContain('Кол-во');
    expect(rendered).not.toContain('Поз.');
    expect(rendered.indexOf('1001')).toBeGreaterThan(-1);
    expect(rendered.indexOf('2002')).toBeGreaterThan(-1);
    expect(rendered.indexOf('1001')).toBeLessThan(rendered.indexOf('2002'));
  });

  it('renders v3 detail tables with generic detail field columns', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('v3-table-generic-detail'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          elements: [
            {
              id: 'table',
              type: 'detail_table',
              x: 10,
              y: 20,
              w: 90,
              h: 45,
              style: {
                sort: { field: 'detail.detail_name', direction: 'asc' },
                columns: [
                  { field: 'detail.detail_name', label: 'Название детали', width: 2, visible: true },
                  { field: 'detail.production_status_name', label: 'Статус', width: 1, visible: true },
                ],
              },
            },
          ],
        },
        detailRows: [
          {
            order: '1001',
            position: 1,
            lengthMm: 500,
            widthMm: 200,
            quantity: 1,
            fields: { detail_name: 'Фасад A', production_status_name: 'К раскрою' },
          },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('Название детали');
    expect(rendered).toContain('Фасад A');
    expect(rendered).toContain('К раскрою');
  });

  it('renders v3 sheet thumbnail layouts on the configured PDF page size', async () => {
    const pdf = await buildSheetsPdf([
      {
        svg: SVG('thumb'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          elements: [
            { id: 'thumb', type: 'sheet_thumbnail', x: 20, y: 30, w: 120, h: 80, rotation: 12, style: { fit: 'contain' } },
          ],
        },
      },
    ]);

    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(pdf.toString('latin1'));
    expect(mediaBox).not.toBeNull();
    expect(Number(mediaBox?.[1])).toBeCloseTo(841.89, 1);
    expect(Number(mediaBox?.[2])).toBeCloseTo(595.28, 1);
  });
});
