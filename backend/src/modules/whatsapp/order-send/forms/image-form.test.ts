import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMAGE_DETAILS_PER_PAGE, fittingSize, paginate, renderOrderImages, wrap } from './image-form';
import { productionProjection, type OrderFormData } from './order-form-data';
import { rows } from './form-layout';

function order(details: number): OrderFormData {
  return {
    orderId: 1, orderName: '230725-Тест', orderDate: new Date('2026-10-02T10:00:00+05:00'), completionDate: new Date('2026-10-15T10:00:00+05:00'),
    clientId: 5, clientName: 'Тест Клиент Длинноеимя', clientPhone: '+7 701 495 20 60', managerId: '1', createdBy: '1',
    totalAmount: 987654, discount: 0, finalAmount: 987654, paidAmount: 111111, prisadkaName: 'П-12', prisadkaDesignerName: 'Тест Конструктор',
    headerMaterial: 'МДФ 16',
    details: Array.from({ length: details }, (_, index) => ({
      detailId: index + 1, height: 700 + index, width: 396, quantity: 1 + (index % 3), millingType: 'Фасад Модерн', edgeType: 'R3',
      film: index % 4 === 0 ? 'Дуб сонома' : 'Белый матовый', material: 'МДФ 16',
      note: index % 5 === 0 ? 'Длинное примечание к детали, которое не поместится в одну строку таблицы и будет перенесено' : `Деталь-${index + 1}`,
      doweling: index === 0, millingCostPerSqm: 54321, detailCost: null,
    })),
    payments: [{ type: 'ТестКаспи', date: new Date('2026-10-02T10:00:00+05:00'), amount: 111111 }],
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const height = (png: Buffer) => png.readUInt32BE(20);
const widthOf = (png: Buffer) => png.readUInt32BE(16);

describe('order image form', () => {
  it('splits by 55 details, a separator never starts or ends a page', () => {
    expect(IMAGE_DETAILS_PER_PAGE).toBe(55);
    const pages = paginate(rows(productionProjection(order(130)), false));
    expect(pages.map((page) => page.filter((row) => row.kind === 'detail').length)).toEqual([55, 55, 20]);
    for (const page of pages) {
      expect(page[0]?.kind).toBe('detail');
      expect(page.at(-1)?.kind).toBe('detail');
    }
    expect(paginate([])).toEqual([[]]);
  });

  it('renders full pictures of one height, the last one cut to its content; one picture for a short order', async () => {
    const short = await renderOrderImages(order(3), true);
    expect(short).toHaveLength(1);
    expect(short[0].subarray(0, 4)).toEqual(PNG);
    const long = await renderOrderImages(order(120), true);
    expect(long).toHaveLength(3);
    expect(height(long[0])).toBe(height(long[1]));
    expect(height(long[2])).toBeLessThan(height(long[0]));
    expect(new Set(long.map(widthOf))).toEqual(new Set([1400]));
    const dir = process.env.ORDER_IMAGE_PREVIEW_DIR;
    if (dir) {
      short.forEach((png, index) => writeFileSync(join(dir, `order-short-${index + 1}.png`), png));
      long.forEach((png, index) => writeFileSync(join(dir, `order-long-${index + 1}.png`), png));
      (await renderOrderImages(productionProjection(order(60)), false)).forEach((png, index) => writeFileSync(join(dir, `production-${index + 1}.png`), png));
    }
  });

  it('wraps to the line limit with an ellipsis', () => {
    expect(wrap('', 100, 17, 2)).toEqual(['']);
    expect(wrap('коротко', 400, 17, 1)).toEqual(['коротко']);
    const lines = wrap('очень длинное примечание к детали которое точно не поместится в узкую колонку', 120, 17, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('the production picture never shows the client phone; the order picture does', async () => {
    const { drawSvgForTest } = await import('./image-form');
    const production = drawSvgForTest(productionProjection(order(3)), false);
    expect(production).not.toContain('701 495');
    expect(production).not.toContain('телефон');
    expect(drawSvgForTest(order(3), true)).toContain('701 495');
  });

  it('numbers get a smaller font instead of being cut (detail 1000 in the narrow «№»)', () => {
    expect(fittingSize('1000', 30, 17)).toBeLessThan(17);
    expect(fittingSize('1100', 30, 17)).toBeGreaterThanOrEqual(9);
    expect(fittingSize('7', 30, 17)).toBe(17);
  });
});
