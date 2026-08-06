import { describe, expect, it } from 'vitest';
import {
  buildOrderProductionPdfDocument,
  groupOrderProductionDetailsByFilm,
  openOrderProductionPdfPreview,
} from './orderProductionPdf';

const params = {
  order: {
    orderId: 42,
    orderName: 'Фасады <Кухня & бар>',
    orderDate: '2026-08-06',
    clientName: 'ТОО "Заказчик"',
    clientPhone: '+7 700 000 00 00',
    prisadkaName: 'П-17',
    prisadkaDesignerName: 'Иванов',
  },
  details: [
    {
      detail_id: 101,
      length: 720,
      width: 410,
      quantity: 2,
      milling_cost_per_sqm: 987654,
      detail_cost: 876543,
      notes: 'Белая группа 1 <левая>',
      milling_type: { milling_type_name: 'Квадро' },
      edge_type: { edge_type_name: 'R2' },
      film: { film_name: 'Белый & матовый' },
      material: { material_name: 'МДФ 16' },
    },
    { kind: 'blank' as const },
    {
      detail_id: 102,
      length: 600,
      width: 300,
      quantity: 1,
      milling_cost_per_sqm: 765432,
      detail_cost: 654321,
      notes: 'Чёрная группа',
      milling_type: { milling_type_name: 'Квадро' },
      edge_type: { edge_type_name: 'R2' },
      film: { film_name: 'Чёрный софт' },
      material: { material_name: 'МДФ 16' },
    },
    {
      detail_id: 103,
      length: 500,
      width: 200,
      quantity: 1,
      milling_cost_per_sqm: 543210,
      detail_cost: 432109,
      notes: 'Белая группа 2',
      milling_type: { milling_type_name: 'Квадро' },
      edge_type: { edge_type_name: 'R2' },
      film: { film_name: 'Белый & матовый' },
      material: { material_name: 'МДФ 16' },
    },
  ],
};

describe('production order PDF document', () => {
  it('keeps the standard Excel A:M header and detail column labels', () => {
    const html = buildOrderProductionPdfDocument(params);

    expect(html).toContain('class="excel-order-header"');
    expect(html).toContain('data-excel-range="A1"');
    expect(html).toContain('class="excel-order-year excel-top-cell">26</td>');
    expect(html).not.toContain('Ф26-42');
    expect(html).not.toContain('Заказ Ф26-42');
    expect(html).toContain('Фасады &lt;Кухня &amp; бар&gt;');
    expect(html).toContain('ТОО &quot;Заказчик&quot;');
    expect(html).toContain('П-17');
    expect(html).toContain('конструктор Иванов');
    expect(html).toContain('МДФ 16');

    for (const heading of [
      '№',
      'Высота',
      'Ширина',
      'Кол-во',
      'Площадь',
      'Тип детали',
      'Обкат',
      'Примечание',
      'Цена за кв.м.',
      'Сумма',
    ]) {
      expect(html).toContain(`<th scope="col">${heading}</th>`);
    }
    expect(html).toContain('<th scope="col" colspan="3">Пленка</th>');

    expect(html).toContain('Белая группа 1 &lt;левая&gt;');
    expect(html).toContain('Белый &amp; матовый');
    expect(html).toContain('0,59');
    expect(html).toContain('общая площадь');
    expect(html).toContain('0,87');
    expect(html).toContain('кол-во деталей');
    expect(html).toContain('4');
  });

  it('mirrors the Excel A1:M9 header geometry and typography', () => {
    const html = buildOrderProductionPdfDocument(params);

    for (const range of [
      'A1',
      'B1',
      'C1:C3',
      'D1',
      'D2:D3',
      'E1:I1',
      'E2:I3',
      'J1:K1',
      'J2:K3',
      'L1:M1',
      'L2:M3',
      'A4:C4',
      'A5:C7',
      'D4:E4',
      'D5:E7',
      'F4:G4',
      'F5:G7',
      'H4:I4',
      'H5:H7',
      'I5:I7',
      'J4:J5',
      'K4:M5',
      'J6:J7',
      'K6:M7',
      'A8:B9',
      'C8:E9',
      'F8:F9',
      'G8:G9',
      'H8:I9',
      'J8:J9',
      'K8:K9',
      'L8:L9',
      'M8:M9',
    ]) {
      expect(html).toContain(`data-excel-range="${range}"`);
    }

    expect(html).toContain('font-family: Calibri, Arial, Helvetica, sans-serif');
    expect(html).toContain('.excel-order-header .excel-order-name {\n      font-size: 16pt;');
    expect(html).toContain('.excel-client-label { font-size: 12pt; font-weight: 700; }');
    expect(html).toContain('.excel-header-row-1 { height: 13.15pt; }');
    expect(html).toContain('.excel-header-row-4 { height: 12pt; }');
    expect(html).toContain('.excel-header-row-9 { height: 12.75pt; }');
  });

  it('keeps financial fields visible but empty and omits payment sections', () => {
    const html = buildOrderProductionPdfDocument(params);

    expect(html).toContain('общая сумма');
    expect(html).toContain('скидка');
    expect(html).toContain('остаток оплаты');
    expect(html).toMatch(/data-field="total-amount"[^>]*><\/td>/);
    expect(html).toMatch(/data-field="discount"[^>]*><\/td>/);
    expect(html).toMatch(/data-field="outstanding"[^>]*><\/td>/);
    expect(html.match(/class="number financial-cell"><\/td>/g)).toHaveLength(6);
    expect(html).not.toContain('987654');
    expect(html).not.toContain('876543');
    expect(html).not.toContain('765432');
    expect(html).not.toContain('654321');
    expect(html).not.toContain('543210');
    expect(html).not.toContain('432109');
    expect(html).not.toContain('Тип оплаты');
    expect(html).not.toContain('Дата оплаты');
    expect(html).not.toContain('Сумма оплаты');
  });

  it('always groups details by film with exactly one blank row between groups', () => {
    const grouped = groupOrderProductionDetailsByFilm(params.details);
    expect(grouped.map((row) => ('kind' in row ? row.kind : row.detail_id))).toEqual([
      101,
      103,
      'blank',
      102,
    ]);

    const html = buildOrderProductionPdfDocument(params);
    expect(html.match(/class="detail-separator"/g)).toHaveLength(1);
    expect(html.indexOf('Белая группа 1')).toBeLessThan(html.indexOf('Белая группа 2'));
    expect(html.indexOf('Белая группа 2')).toBeLessThan(html.indexOf('class="detail-separator"'));
    expect(html.indexOf('class="detail-separator"')).toBeLessThan(html.indexOf('Чёрная группа'));
  });

  it('uses a repeating spreadsheet header on white A4 portrait pages', () => {
    const html = buildOrderProductionPdfDocument(params);

    expect(html).toContain('size: A4 portrait');
    expect(html).not.toContain('size: A4 landscape');
    expect(html).toMatch(/th, td \{[\s\S]*?background: #fff;/);
    expect(html).not.toContain('background: #e7e7e7');
    expect(html).not.toContain('background: #e8e8e8');
    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('font-variant-numeric: tabular-nums');
  });

  it('does not open preview outside a browser document', () => {
    expect(openOrderProductionPdfPreview(params)).toBe(false);
  });
});
