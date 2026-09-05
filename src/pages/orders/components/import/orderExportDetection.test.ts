import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { buildOrderExcelBuffer, type OrderExcelDetailRow } from '../../../../utils/excel/orderExcelBuilder';
import { parseWorksheet } from './hooks/useExcelParser';
import { detectOrderExport, extractImportRows } from './orderExportDetection';

async function exportedSheet(details: OrderExcelDetailRow[], pricingMode: 'full' | 'omit' = 'full') {
  const template = readFileSync('public/templates/order_template.xlsx');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength),
  })));
  const buffer = await buildOrderExcelBuffer({
    order: { order_id: 501, order_name: 'Import test', order_date: '2026-09-05' },
    details, pricingMode,
    payments: Array.from({ length: 15 }, (_, i) => ({ payment_id: i + 1, amount: 9999, payment_date: '2026-09-05' })),
  });
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  return parseWorksheet(workbook.Sheets[workbook.SheetNames[0]], XLSX.utils);
}

function detail(index: number): OrderExcelDetailRow {
  return {
    detail_id: index, length: 700 + index, width: 400, quantity: 2,
    milling_type: { milling_type_name: 'Классика' }, edge_type: { edge_type_name: 'Р-1' },
    film: { film_name: `Плёнка ${index}` }, material: { material_name: 'МДФ 16' },
    notes: `Заметка ${index}`, doweling: index === 1,
  };
}

describe('application order export recognition', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['full', 'omit'] as const)('round-trips all exported import fields (%s pricing), excluding payments/footer/formulas', async (pricingMode) => {
    const sheet = await exportedSheet([detail(1), { kind: 'blank' }, detail(2)], pricingMode);
    const result = detectOrderExport(sheet)!;
    expect(result).not.toBeNull();
    expect(result.range).toMatchObject({ startRow: 10, endRow: 13, startCol: 0, endCol: 10 });
    expect(result.mapping).toEqual({ height: 'B', width: 'C', quantity: 'D', milling_type: 'F',
      edge_type: 'G', note: 'H', film: 'K', material: null, detail_name: null });
    const rows = extractImportRows(sheet, [result.range], result.mapping, true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ height: 701, width: 400, quantity: 2, millingTypeName: 'Классика',
      edgeTypeName: 'Р-1', filmName: 'Плёнка 1', note: 'Присадка\nЗаметка 1', materialName: 'МДФ 16' });
    expect(rows[0].doweling).toBeUndefined(); // A free-text note cannot prove a boolean.
    expect(rows[0].detailName).toBeNull(); // Not exported; never invent it from Тип детали.
    expect(rows[1]).toMatchObject({ sourceRowIndex: 13, height: 702 });
  });

  it('recognizes every detail beyond both the template and old 150-row preview limit', async () => {
    const sheet = await exportedSheet(Array.from({ length: 170 }, (_, i) => detail(i + 1)));
    const result = detectOrderExport(sheet)!;
    expect(result.range.endRow).toBe(180);
    const rows = extractImportRows(sheet, [result.range], result.mapping, true);
    expect(rows).toHaveLength(170);
    expect(rows.at(-1)?.height).toBe(870);
  });

  it('keeps malformed required values for validation instead of silently dropping the detail', async () => {
    const sheet = await exportedSheet([detail(1), detail(2)]);
    sheet.data[12][1] = 'ошибка';
    const result = detectOrderExport(sheet)!;
    expect(extractImportRows(sheet, [result.range], result.mapping, true)[1].height).toBe('ошибка');
  });

  it('never infers doweling from a user-authored note containing Присадка', async () => {
    const sheet = await exportedSheet([{ ...detail(1), doweling: false, notes: 'Присадка' } as OrderExcelDetailRow]);
    const result = detectOrderExport(sheet)!;
    const [row] = extractImportRows(sheet, [result.range], result.mapping, true);
    expect(row.note).toBe('Присадка');
    expect(row.doweling).toBeUndefined();
  });

  it('does not select empty exports or mistake a generic dimensions table for our template', async () => {
    expect(detectOrderExport(await exportedSheet([]))).toBeNull();
    const sheet = parseWorksheet(XLSX.utils.aoa_to_sheet([['№', 'Высота', 'Ширина', 'Кол-во'], [1, 700, 400, 2]]), XLSX.utils);
    expect(detectOrderExport(sheet)).toBeNull();
  });

  it('respects a manually mapped material and does not import rows twice for overlapping ranges', async () => {
    const sheet = await exportedSheet([detail(1)]);
    const result = detectOrderExport(sheet)!;
    const rows = extractImportRows(sheet, [result.range, result.range], { ...result.mapping, material: 'K' }, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].materialName).toBe('Плёнка 1');
  });
});
