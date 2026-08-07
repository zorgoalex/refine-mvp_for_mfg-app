import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { buildSheetsPdf, stretchSvgToBounds } from './sheet-pdf';
import { FONT_FAMILY } from './sheet-png';

const SVG = (label: string) =>
  `<svg viewBox="0 0 2800 2070"><rect x="0" y="0" width="2800" height="2070" fill="#fff"/><text x="100" y="100">${label}</text></svg>`;
const SHEET_PDF_SOURCE = readFileSync(new URL('./sheet-pdf.ts', import.meta.url), 'utf8');

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
    expect(rendered).toContain('Количество деталей:');
    expect(rendered).toContain('3');
    expect(rendered).toContain('Площадь деталей:');
    expect(rendered).toContain('Утилизация');
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
    const clientValueCall = textSpy.mock.calls.find((call) => call[0] === 'Тлек Бакенов');

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

    expect(filmValueCall?.[0]).toBe('Крем брюле -Декор+, Белый глянец, Олива софт -МС групп');
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

  it('resolves empty bath profile layouts to the editable bath v3 layout', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('bath-empty-layout'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'bath_profiles',
        templateLayout: {},
        meta: { clients: ['Тестовый клиент'] },
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).toContain('Клиент:');
    expect(rendered).toContain('Тестовый клиент');
    expect(rendered).toContain('Количество деталей:');
    expect(rendered).toContain('Площадь деталей:');
    expect(rendered).toContain('Утилизация');
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

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('Лист');
    expect(rendered).toContain('3');
  });

  it('keeps bath detail table cells inside bounded wrapping boxes', async () => {
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
    expect(orderCall?.[3]).toMatchObject({ lineBreak: true, ellipsis: true, align: 'center' });
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
    expect(rendered).toContain('Количество деталей:');
    expect(rendered).toContain('5');
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

  it('renders v3 custom aggregate fields over current sheet detail rows', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('v3-aggregate-field'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          customFieldSchema: {
            'custom.edge_types': {
              type: 'string',
              label: 'Обкаты',
              expression: {
                type: 'custom_expression',
                version: 1,
                root: {
                  type: 'aggregate',
                  source: 'sheet.details',
                  field: 'detail.edge_type_name',
                  fn: 'unique_join',
                  separator: ', ',
                },
              },
            },
          },
          elements: [
            { id: 'edge-types', type: 'field', source: 'custom.edge_types', x: 10, y: 10, w: 90, h: 10 },
          ],
        },
        detailRows: [
          {
            order: '1001',
            position: 1,
            lengthMm: 500,
            widthMm: 200,
            quantity: 1,
            fields: { edge_type_name: 'ПВХ 2мм' },
          },
          {
            order: '1001',
            position: 2,
            lengthMm: 300,
            widthMm: 100,
            quantity: 1,
            fields: { edge_type_name: 'ABS 1мм' },
          },
          {
            order: '1001',
            position: 3,
            lengthMm: 200,
            widthMm: 100,
            quantity: 1,
            fields: { edge_type_name: 'ПВХ 2мм' },
          },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('ПВХ 2мм, ABS 1мм');
  });

  it('renders empty seeded template layouts with default detail and machine-file tables', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    const pdf = await buildSheetsPdf([
      {
        svg: SVG('seeded-empty-layout'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        template: 'standard',
        templateLayout: {},
        meta: {
          orders: ['11380'],
          clients: ['Тестовый клиент'],
          films: ['Крем брюле -Декор+'],
          machineFiles: ['CNC#1_11380.TXT'],
        },
        detailRows: [
          {
            order: '11380',
            position: 12,
            lengthMm: 800,
            widthMm: 240,
            quantity: 2,
            machineFiles: ['CNC#1_11380.TXT'],
            fields: { doweling: true, machine_file: 'CNC#1_11380.TXT' },
          },
        ],
      },
    ]);

    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(pdf.toString('latin1'));
    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(Number(mediaBox?.[1])).toBeCloseTo(841.89, 1);
    expect(Number(mediaBox?.[2])).toBeCloseTo(595.28, 1);
    expect(rendered).toContain('Присадка');
    expect(rendered).toContain('Файл станка');
    expect(rendered).toContain('Файлы станка');
    expect(rendered).toContain('Да');
    expect(rendered).not.toContain('✓');
    expect(rendered).toContain('CNC#1_11380.TXT');
  });

  it('upgrades legacy v3 detail table defaults with doweling and machine-file columns', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('v3-table-machine-defaults'),
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
              w: 120,
              h: 45,
              style: {
                columns: [
                  { field: 'detail.row_number', label: '#', width: 0.55, visible: true },
                  { field: 'detail.order', label: 'Заказ', width: 1.6, visible: true },
                  { field: 'detail.position', label: 'Поз.', width: 0.9, visible: true },
                  { field: 'detail.lengthMm', label: 'Длина', width: 1.1, visible: true },
                  { field: 'detail.widthMm', label: 'Ширина', width: 1.1, visible: true },
                  { field: 'detail.quantity', label: 'Кол-во', width: 0.9, visible: true },
                ],
              },
            },
          ],
        },
        detailRows: [
          {
            order: '11380',
            position: 12,
            lengthMm: 800,
            widthMm: 240,
            quantity: 2,
            machineFiles: ['CNC#1_11380.TXT'],
            fields: { doweling: true, machine_file: 'CNC#1_11380.TXT' },
          },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('Присадка');
    expect(rendered).toContain('Файл станка');
    expect(rendered).toContain('Да');
    expect(rendered).not.toContain('✓');
    expect(rendered).toContain('CNC#1_11380.TXT');
  });

  it('renders v3 machine file tables with one unique file name per row', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('v3-machine-files'),
        sheetWidthMm: 2800,
        sheetHeightMm: 2070,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          elements: [
            { id: 'files', type: 'machine_files_table', x: 10, y: 20, w: 70, h: 28, style: { fontSize: 7 } },
          ],
        },
        meta: { machineFiles: ['CNC#2_11380.TXT'] },
        detailRows: [
          {
            order: '11380',
            position: 12,
            lengthMm: 800,
            widthMm: 240,
            quantity: 1,
            machineFiles: ['CNC#1_11380.TXT', 'CNC#2_11380.TXT'],
            fields: { machine_file: 'CNC#1_11380.TXT' },
          },
          {
            order: '11380',
            position: 13,
            lengthMm: 780,
            widthMm: 255,
            quantity: 1,
            fields: { machine_files: 'CNC#1_11380.TXT, CNC#3_11380.TXT' },
          },
        ],
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('Файлы станка');
    expect(rendered.filter((value) => value === 'CNC#1_11380.TXT')).toHaveLength(1);
    expect(rendered).toContain('CNC#2_11380.TXT');
    expect(rendered).toContain('CNC#3_11380.TXT');
  });

  it('renders cut identity and per-sheet bath film requirement fields', async () => {
    const textSpy = vi.spyOn(PDFDocument.prototype, 'text');
    await buildSheetsPdf([
      {
        svg: SVG('cut-fields'),
        sheetWidthMm: 1400,
        sheetHeightMm: 2800,
        cutJobId: 42,
        cutNumber: '42-3',
        currentCutNumber: '42-4',
        jobName: 'Задание ванна',
        textureDirection: 'Вертикальное',
        filmRequirementLinearMeters: 2.1,
        templateLayout: {
          version: 3,
          page: { width: 297, height: 210 },
          elements: [
            { id: 'job', type: 'field', source: 'job.number', x: 10, y: 10, w: 40, h: 8 },
            { id: 'cut', type: 'field', source: 'cut.number', x: 10, y: 20, w: 40, h: 8 },
            { id: 'current-cut', type: 'field', source: 'cut.current_version', x: 10, y: 30, w: 40, h: 8 },
            { id: 'film', type: 'field', source: 'sheet.film_requirement', x: 10, y: 40, w: 60, h: 8 },
            { id: 'texture', type: 'field', source: 'job.texture_direction', x: 10, y: 50, w: 60, h: 8 },
          ],
        },
      },
    ]);

    const rendered = textSpy.mock.calls.map((call) => String(call[0]));
    expect(rendered).toContain('42');
    expect(rendered).toContain('42-3');
    expect(rendered).toContain('42-4');
    expect(rendered).toContain('2,1 пог. м');
    expect(rendered).toContain('Вертикальное');
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

  it('forces sheet thumbnails to stretch over the full template element bounds', () => {
    expect(stretchSvgToBounds('<svg viewBox="0 0 2800 2070"><rect/></svg>'))
      .toContain('<svg preserveAspectRatio="none" viewBox="0 0 2800 2070">');
    expect(stretchSvgToBounds('<svg preserveAspectRatio="xMidYMid meet" viewBox="0 0 1 1"/>'))
      .toContain('preserveAspectRatio="none"');
    expect(SHEET_PDF_SOURCE).toContain('SVGtoPDF(doc, stretchSvgToBounds(sheet.bathSvg ?? sheet.svg, w, h), 0, 0');
    expect(SHEET_PDF_SOURCE).toContain('width: w');
    expect(SHEET_PDF_SOURCE).toContain('height: h');
    expect(SHEET_PDF_SOURCE).not.toContain("style.fit ?? 'contain'");
  });

  it('keeps text glyph proportions while stretching the sheet geometry', () => {
    const stretched = stretchSvgToBounds(
      '<svg viewBox="0 0 100 50"><rect width="100" height="50"/><text x="50" y="10">800</text></svg>',
      300,
      300,
    );

    expect(stretched).toContain('preserveAspectRatio="none"');
    expect(stretched).toContain('class="cut-pdf-text-aspect-lock"');
    expect(stretched).toContain('transform="translate(50 10) scale(1 0.5) translate(-50 -10)"');
  });

  it('keeps piece clipping aligned when compensating metadata text proportions', () => {
    const stretched = stretchSvgToBounds(
      '<svg viewBox="0 0 100 50"><clipPath id="piece"><rect width="100" height="50"/></clipPath><text clip-path="url(#piece)"><tspan x="90" y="40">ПВХ 2мм</tspan></text></svg>',
      300,
      300,
    );

    expect(stretched).toContain('<g clip-path="url(#piece)"><g class="cut-pdf-text-aspect-lock"');
    expect(stretched).toMatch(/<text><tspan x="90" y="40">ПВХ 2мм<\/tspan><\/text>/);
  });

  it('renders PDF template text style controls from the editor context menu', () => {
    expect(SHEET_PDF_SOURCE).toContain("style.fontWeight === 'bold'");
    expect(SHEET_PDF_SOURCE).toContain('style.fontItalic === true');
    expect(SHEET_PDF_SOURCE).toContain('doc.transform(1, 0, -0.18, 1, 0, 0)');
  });
});
