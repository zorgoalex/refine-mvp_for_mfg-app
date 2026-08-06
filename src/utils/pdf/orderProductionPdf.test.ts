import { describe, expect, it } from 'vitest';
import {
  buildOrderProductionPdfDocument,
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
      notes: 'Лицевая <левая>',
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
      notes: null,
      milling_type: { milling_type_name: 'Квадро' },
      edge_type: { edge_type_name: 'R2' },
      film: { film_name: 'Белый & матовый' },
      material: { material_name: 'МДФ 16' },
    },
  ],
};

describe('production order PDF document', () => {
  it('contains only the spreadsheet header and every non-financial detail column', () => {
    const html = buildOrderProductionPdfDocument(params);

    expect(html).toContain('Заказ Ф26-42');
    expect(html).toContain('Фасады &lt;Кухня &amp; бар&gt;');
    expect(html).toContain('ТОО &quot;Заказчик&quot;');
    expect(html).toContain('П-17');
    expect(html).toContain('конструктор Иванов');
    expect(html).toContain('МДФ 16');

    for (const heading of [
      '№',
      'Высота, мм',
      'Ширина, мм',
      'Кол-во',
      'Площадь, м²',
      'Тип детали',
      'Обкат',
      'Примечание',
      'Плёнка',
    ]) {
      expect(html).toContain(`<th scope="col">${heading}</th>`);
    }

    expect(html).toContain('Лицевая &lt;левая&gt;');
    expect(html).toContain('Белый &amp; матовый');
    expect(html).toContain('0,59');
    expect(html).toContain('class="detail-separator"');
    expect(html).toContain('Общая площадь');
    expect(html).toContain('0,77 м²');
    expect(html).toContain('Кол-во деталей');
    expect(html).toContain('3');
  });

  it('never renders financial columns, values, or payment sections', () => {
    const html = buildOrderProductionPdfDocument(params);

    expect(html).not.toContain('Цена за кв.м.');
    expect(html).not.toContain('Сумма');
    expect(html).not.toContain('Оплата');
    expect(html).not.toContain('987654');
    expect(html).not.toContain('876543');
    expect(html).not.toContain('765432');
    expect(html).not.toContain('654321');
  });

  it('uses a repeating spreadsheet header on A4 landscape pages', () => {
    const html = buildOrderProductionPdfDocument(params);

    expect(html).toContain('size: A4 landscape');
    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('font-variant-numeric: tabular-nums');
  });

  it('does not open preview outside a browser document', () => {
    expect(openOrderProductionPdfPreview(params)).toBe(false);
  });
});
