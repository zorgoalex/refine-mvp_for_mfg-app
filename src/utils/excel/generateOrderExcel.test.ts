import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { buildOrderExcelBuffer } from './generateOrderExcel';

const templatePath = path.resolve(process.cwd(), 'public/templates/order_template.xlsx');

function makeDetails(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    detail_id: index + 1,
    length: 700 + index,
    width: 400 + index,
    quantity: (index % 3) + 1,
    milling_cost_per_sqm: 1000 + index,
    notes: `Позиция ${index + 1}`,
    milling_type: { milling_type_name: `Фрезеровка ${index + 1}` },
    edge_type: { edge_type_name: `Кромка ${index + 1}` },
    film: { film_name: `Пленка ${index + 1}` },
    material: { material_name: `Материал ${index + 1}` },
  }));
}

async function buildWorkbook(
  detailCount: number,
  pricingMode: 'full' | 'omit' = 'full',
) {
  const template = await fs.readFile(templatePath);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => template.buffer.slice(
      template.byteOffset,
      template.byteOffset + template.byteLength,
    ),
  })));

  const buffer = await buildOrderExcelBuffer({
    order: {
      order_id: 1000 + detailCount,
      order_name: `E2E Excel ${detailCount}`,
      order_date: '2026-06-19',
    },
    details: makeDetails(detailCount),
    payments: [],
    client: { client_name: 'Тестовый клиент' },
    clientPhone: '+7 777 000 00 00',
    pricingMode,
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) throw new Error('worksheet missing');
  return worksheet;
}

describe('buildOrderExcelBuffer dynamic detail rows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([60, 70, 95])('exports all %i order details beyond the 55-row template limit', async (detailCount) => {
    const worksheet = await buildWorkbook(detailCount);
    const lastDetailRow = 11 + detailCount;
    const footerRow = lastDetailRow + 2;

    expect(worksheet.getCell(`B${lastDetailRow}`).value).toBe(700 + detailCount - 1);
    expect(worksheet.getCell(`C${lastDetailRow}`).value).toBe(400 + detailCount - 1);
    expect(worksheet.getCell(`D${lastDetailRow}`).value).toBe(((detailCount - 1) % 3) + 1);
    expect(worksheet.getCell(`H${lastDetailRow}`).value).toBe(`Позиция ${detailCount}`);
    expect(worksheet.getCell(`I${lastDetailRow}`).value).toBe(1000 + detailCount - 1);
    expect(worksheet.getCell(`K${lastDetailRow}`).value).toBe(`Пленка ${detailCount}`);

    expect(worksheet.getCell(`A${lastDetailRow}`).value).toBe(detailCount);
    expect(worksheet.getCell(`E${lastDetailRow}`).value).toEqual({
      formula: `ROUND((B${lastDetailRow}/1000)*(C${lastDetailRow}/1000)*D${lastDetailRow},2)`,
    });
    expect(worksheet.getCell(`J${lastDetailRow}`).value).toEqual({
      formula: `E${lastDetailRow}*I${lastDetailRow}`,
    });
    expect(worksheet.getCell('J2').value).toEqual({ formula: `SUM(J12:J${lastDetailRow})` });
    expect(worksheet.getCell('K8').value).toEqual({
      formula: `ROUND(SUMPRODUCT(B12:B${lastDetailRow},C12:C${lastDetailRow},D12:D${lastDetailRow})/1000000,2)`,
    });
    expect(worksheet.getCell('M8').value).toEqual({ formula: `SUM(D12:D${lastDetailRow})` });
    expect(String(worksheet.getCell(`A${footerRow}`).value)).toContain('С техническими');
    expect(worksheet.pageSetup.printArea).toBe(`A1:M${lastDetailRow + 16}`);
  });

  it('keeps footer signature rows merged and below expanded detail rows', async () => {
    const worksheet = await buildWorkbook(70);
    const shiftedFooterStartRow = 68 + (70 - 55);

    expect(worksheet.getCell(`A${shiftedFooterStartRow}`).value).toBe(
      'С техническими и технологическими особенностями ознакомлен, количество и размеры верны',
    );
    expect(worksheet.getCell(`A${shiftedFooterStartRow}`).isMerged).toBe(true);
    expect(worksheet.getCell(`H${shiftedFooterStartRow + 1}`).isMerged).toBe(true);
    expect(worksheet.getCell(`A${shiftedFooterStartRow + 1}`).style.alignment).toMatchObject({
      horizontal: 'right',
      vertical: 'middle',
      wrapText: true,
    });
    expect(worksheet.getCell(`A${shiftedFooterStartRow + 1}`).style.font).toMatchObject({
      italic: true,
      size: 9,
    });
    expect(worksheet.getCell(`I${shiftedFooterStartRow}`).value).toBe('(фамилия)');

    expect(worksheet.getCell(`A${shiftedFooterStartRow + 2}`).isMerged).toBe(true);
    expect(worksheet.getCell(`I${shiftedFooterStartRow + 2}`).isMerged).toBe(true);

    expect(worksheet.getCell(`A${shiftedFooterStartRow + 3}`).value).toBe(
      'Техникалық және технологиялық ерекшелерімен таныстым, саны және өлшемі дұрыс',
    );
    expect(worksheet.getCell(`A${shiftedFooterStartRow + 3}`).isMerged).toBe(true);
    expect(worksheet.getCell(`H${shiftedFooterStartRow + 4}`).isMerged).toBe(true);
    expect(worksheet.getCell(`A${shiftedFooterStartRow + 4}`).style.alignment).toMatchObject({
      horizontal: 'right',
      vertical: 'middle',
      wrapText: true,
    });
    expect(worksheet.getCell(`A${shiftedFooterStartRow + 4}`).style.font).toMatchObject({
      italic: true,
      size: 9,
    });
    expect(worksheet.getCell(`I${shiftedFooterStartRow + 3}`).value).toBe('(подпись)');

    expect(worksheet.getCell('A68').isMerged).toBe(false);
    expect(worksheet.getCell('H69').isMerged).toBe(false);
  });

  it('keeps price columns but leaves all price values and order totals empty in omit mode', async () => {
    const worksheet = await buildWorkbook(3, 'omit');

    expect(worksheet.getCell('I11').value).toBe('Цена за кв.м.');
    expect(worksheet.getCell('J11').value).toBe('Сумма');
    expect(worksheet.getCell('I12').value).toBeNull();
    expect(worksheet.getCell('J12').value).toBeNull();
    expect(worksheet.getCell('I14').value).toBeNull();
    expect(worksheet.getCell('J14').value).toBeNull();
    expect(worksheet.getCell('I66').value).toBeNull();
    expect(worksheet.getCell('J66').value).toBeNull();

    expect(worksheet.getCell('J2').value).toBeNull();
    expect(worksheet.getCell('L2').value).toBeNull();
    expect(worksheet.getCell('K4').value).toBeNull();

    expect(worksheet.getCell('E12').value).toEqual({
      formula: 'ROUND((B12/1000)*(C12/1000)*D12,2)',
    });
    expect(worksheet.getCell('K8').value).toEqual({
      formula: 'ROUND(SUMPRODUCT(B12:B66,C12:C66,D12:D66)/1000000,2)',
    });
    expect(worksheet.getCell('M8').value).toEqual({ formula: 'SUM(D12:D66)' });
  });
});
