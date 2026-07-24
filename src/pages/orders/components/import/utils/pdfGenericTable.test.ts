import { describe, expect, it } from 'vitest';
import { detectGenericPdfTables, inferredMapping, mapGenericTableRows } from './pdfGenericTable';
import { serializePdfLayoutSignature } from './pdfLayoutPattern';
import type { PdfTextItem } from '../types/pdfTypes';

const item = (text: string, x: number, y: number): PdfTextItem => ({
  text, x, y, width: Math.max(8, text.length * 4), height: 10,
});

describe('generic PDF table detector', () => {
  it('detects translated table and retains wrapped designation', () => {
    const page = [
      item('№', 100, 500), item('Обозн.', 140, 500), item('Наименование', 230, 500),
      item('Кол-во', 400, 500), item('Размер', 470, 500),
      item('1', 100, 470), item('00.00.01', 140, 470), item('Фасад', 230, 470),
      item('2', 400, 470), item('700 400', 470, 470),
      item('.05', 140, 460), item('левый', 230, 460),
    ];
    const [table] = detectGenericPdfTables([page]);
    expect(table.rows[0][1]).toBe('00.00.01.05');
    expect(table.signature.columns[0].relativeStart).toBe(0);
    const mapped = mapGenericTableRows(table, inferredMapping(table));
    expect(mapped.issues).toEqual([]);
    expect(mapped.rows[0]).toMatchObject({
      detailName: 'Фасад левый',
      basisDesignation: '00.00.01.05',
      quantity: 2,
      height: 700,
      width: 400,
    });
  });

  it('supports tables without position column', () => {
    const page = [
      item('Наименование', 100, 500), item('Кол-во', 300, 500),
      item('Длина', 380, 500), item('Ширина', 450, 500),
      item('Полка', 100, 470), item('3', 300, 470),
      item('500', 380, 470), item('300', 450, 470),
    ];
    const [table] = detectGenericPdfTables([page]);
    const mapped = mapGenericTableRows(table, inferredMapping(table));
    expect(mapped.issues).toEqual([]);
    expect(mapped.rows[0]).toMatchObject({
      detailName: 'Полка',
      quantity: 3,
      height: 500,
      width: 300,
    });
  });

  it('retains geometry-stable tables with unknown headers for manual mapping', () => {
    const page = [
      item('A', 100, 500), item('B', 200, 500), item('C', 300, 500), item('D', 400, 500),
      item('x1', 100, 470), item('y1', 200, 470), item('1', 300, 470), item('10 20', 400, 470),
      item('x2', 100, 450), item('y2', 200, 450), item('2', 300, 450), item('20 30', 400, 450),
      item('x3', 100, 430), item('y3', 200, 430), item('3', 300, 430), item('30 40', 400, 430),
    ];
    const [table] = detectGenericPdfTables([page]);
    expect(table.columns.map(column => column.inferredTarget)).toEqual([
      'ignore', 'ignore', 'ignore', 'ignore',
    ]);
    expect(table.rows).toHaveLength(3);
  });

  it('never fingerprints possible document values in geometry-only layouts', () => {
    const page = (prefix: string) => [
      item(`${prefix}-document-value`, 100, 500), item('other', 200, 500),
      item('3', 300, 500), item('10 20', 400, 500),
      item('row1', 100, 470), item('name1', 200, 470), item('1', 300, 470), item('10 20', 400, 470),
      item('row2', 100, 450), item('name2', 200, 450), item('2', 300, 450), item('20 30', 400, 450),
      item('row3', 100, 430), item('name3', 200, 430), item('3', 300, 430), item('30 40', 400, 430),
    ];
    const first = detectGenericPdfTables([page('first')])[0];
    const second = detectGenericPdfTables([page('second')])[0];
    expect(first.signature.columns.map(column => column.header)).toEqual([
      'column-1', 'column-2', 'column-3', 'column-4',
    ]);
    expect(serializePdfLayoutSignature(first.signature))
      .toBe(serializePdfLayoutSignature(second.signature));
    const mapped = mapGenericTableRows(first, {
      schemaVersion: 1,
      geometryCandidateRole: 'data',
      columns: [
        { columnIndex: 0, target: 'designation' },
        { columnIndex: 1, target: 'name' },
        { columnIndex: 2, target: 'quantity' },
        { columnIndex: 3, target: 'compound_size' },
      ],
    });
    expect(mapped.rows).toHaveLength(4);
    expect(mapped.rows[0]).toMatchObject({
      detailName: 'other',
      quantity: 3,
      height: 10,
      width: 20,
    });
  });

  it('separates multiple tables and retains a later unknown layout', () => {
    const page = [
      item('№', 100, 600), item('Наименование', 200, 600),
      item('Кол-во', 300, 600), item('Размер', 400, 600),
      item('1', 100, 570), item('Фасад', 200, 570), item('1', 300, 570), item('10 20', 400, 570),
      item('Общ. кол. 1', 100, 550),
      item('A', 100, 500), item('B', 200, 500), item('C', 300, 500), item('D', 400, 500),
      item('x1', 100, 470), item('y1', 200, 470), item('1', 300, 470), item('10 20', 400, 470),
      item('x2', 100, 450), item('y2', 200, 450), item('2', 300, 450), item('20 30', 400, 450),
      item('x3', 100, 430), item('y3', 200, 430), item('3', 300, 430), item('30 40', 400, 430),
    ];
    const tables = detectGenericPdfTables([page]);
    expect(tables).toHaveLength(2);
    expect(tables[0].rows).toHaveLength(1);
    expect(tables[1].signature.columns[0].header).toBe('column-1');
  });

  it('attaches a headerless page only when row geometry matches', () => {
    const headerPage = [
      item('№', 100, 500), item('Наименование', 200, 500),
      item('Кол-во', 300, 500), item('Размер', 400, 500),
      item('1', 100, 470), item('Фасад', 200, 470), item('1', 300, 470), item('10 20', 400, 470),
    ];
    const continuationPage = [
      item('2', 100, 470), item('Полка', 200, 470), item('2', 300, 470), item('20 30', 400, 470),
    ];
    const unrelatedPage = [item('Свободный текст', 50, 470), item('без таблицы', 500, 470)];
    expect(detectGenericPdfTables([headerPage, continuationPage])).toHaveLength(2);
    expect(detectGenericPdfTables([headerPage, unrelatedPage])).toHaveLength(1);
  });

  it('finds a changed layout after a vertical section gap without a footer', () => {
    const page = [
      item('№', 100, 600), item('Наименование', 200, 600),
      item('Кол-во', 300, 600), item('Размер', 400, 600),
      item('1', 100, 570), item('Фасад', 200, 570), item('1', 300, 570), item('10 20', 400, 570),
      item('A', 80, 480), item('B', 210, 480), item('C', 350, 480), item('D', 500, 480),
      item('x1', 80, 450), item('y1', 210, 450), item('1', 350, 450), item('10 20', 500, 450),
      item('x2', 80, 430), item('y2', 210, 430), item('2', 350, 430), item('20 30', 500, 430),
      item('x3', 80, 410), item('y3', 210, 410), item('3', 350, 410), item('30 40', 500, 410),
    ];
    expect(detectGenericPdfTables([page])).toHaveLength(2);
  });

  it('retains single-cell wrapped fragments and rejects fractional quantity', () => {
    const page = [
      item('№', 100, 500), item('Наименование', 200, 500),
      item('Кол-во', 300, 500), item('Размер', 400, 500),
      item('1', 100, 470), item('Фасад', 200, 470), item('1.5', 300, 470), item('10 20', 400, 470),
      item('левый', 200, 460),
    ];
    const table = detectGenericPdfTables([page])[0];
    expect(table.rows[0][1]).toBe('Фасад левый');
    const mapped = mapGenericTableRows(table, inferredMapping(table));
    expect(mapped.rows).toHaveLength(0);
    expect(mapped.issues[0]).toContain('обязательные поля');
  });

  it('assigns vertically offset cells to the nearest anchored row', () => {
    const page = [
      item('№', 53, 400.6), item('Обозн.', 87.9, 400.6),
      item('Наименование', 157.1, 400.6), item('Кол-во', 245.2, 400.6),
      item('Размер, мм', 295.7, 400.6), item('Фрезировка', 404.7, 400.6),
      item('Пленка', 581.8, 400.6), item('Примечание', 721.8, 400.6),

      item('1760', 288.1, 387.3), item('192', 332.8, 387.3),
      item('Алатау мат. KZ 03', 562.2, 387.3),
      item('1', 64.2, 382.2), item('00.00.01.03', 74.6, 382.2),
      item('Вертикальная', 160.2, 382.2), item('2', 268.3, 382.2),
      item('Модерн', 414.3, 382.2), item('kira', 589.6, 382.2),

      item('1425', 288.1, 364.6), item('346', 332.8, 364.6),
      item('Алатау мат. KZ 03', 562.2, 364.6),
      item('2', 64.2, 359.5), item('00.00.01.04', 74.6, 359.5),
      item('Дверь', 175.1, 359.5), item('2', 268.3, 359.5),
      item('Модерн', 414.3, 359.5), item('kira', 589.6, 359.5),
      item('Присадка:', 727.2, 359.5),

      item('698', 290.3, 341.9), item('100', 332.8, 341.9),
      item('Алатау мат. KZ 03', 562.2, 341.9),
      item('3', 64.2, 336.9), item('00.00.01.08', 74.6, 336.9),
      item('Фронтальная', 161.7, 336.9), item('1', 268.3, 336.9),
      item('Модерн', 414.3, 336.9), item('kira', 589.6, 336.9),
    ];

    const table = detectGenericPdfTables([page])[0];
    const mapped = mapGenericTableRows(table, inferredMapping(table));

    expect(table.unresolvedLines).toEqual([]);
    expect(mapped.issues).toEqual([]);
    expect(mapped.rows).toMatchObject([
      { height: 1760, width: 192, quantity: 2, filmName: 'Алатау мат. KZ 03 kira' },
      { height: 1425, width: 346, quantity: 2, filmName: 'Алатау мат. KZ 03 kira' },
      { height: 698, width: 100, quantity: 1, filmName: 'Алатау мат. KZ 03 kira' },
    ]);
  });

  it('requires a document-local decision for unattached lines', () => {
    const page = [
      item('№', 100, 500), item('Наименование', 200, 500),
      item('Кол-во', 300, 500), item('Размер', 400, 500),
      item('уточнение', 200, 470),
      item('1', 100, 430), item('Фасад', 200, 430), item('1', 300, 430), item('10 20', 400, 430),
    ];
    const table = detectGenericPdfTables([page])[0];
    const mapping = inferredMapping(table);
    expect(table.unresolvedLines).toHaveLength(1);
    expect(mapGenericTableRows(table, mapping).issues).toContain(
      'Не классифицирована строка таблицы 1',
    );
    expect(mapGenericTableRows(table, mapping, { 0: { kind: 'ignore' } }).issues).toEqual([]);
    const attached = mapGenericTableRows(table, mapping, {
      0: { kind: 'attach', rowIndex: 0 },
    });
    expect(attached.issues).toEqual([]);
    expect(attached.rows[0].detailName).toBe('Фасад уточнение');
  });

  it('fails closed on page and column complexity limits', () => {
    expect(() => detectGenericPdfTables(Array.from({ length: 101 }, () => [])))
      .toThrow('PDF_COMPLEXITY_LIMIT');
    const oversizedHeader = Array.from({ length: 51 }, (_, index) =>
      item(index % 2 === 0 ? 'Наименование' : 'Кол-во', index * 20, 500));
    expect(() => detectGenericPdfTables([oversizedHeader]))
      .toThrow('максимум 50 колонок');
  });
});
