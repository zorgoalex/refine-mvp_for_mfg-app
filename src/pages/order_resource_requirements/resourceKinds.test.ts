import { describe, expect, it } from 'vitest';
import type { OrderResourceDemandDto } from '../../api/types/orderApi.types';
import {
  RESOURCE_KINDS,
  formatKindTotal,
  formatLineQuantity,
  orderDisplayName,
  positionsLabel,
  resourceDemandLines,
  resourceKindTotal,
  type ResourceDemandLine,
} from './resourceKinds';

function makeRow(overrides: Partial<OrderResourceDemandDto> = {}): OrderResourceDemandDto {
  return {
    orderId: 3101,
    orderName: 'E2E-Тест 3101',
    fullNumber: 'PRJ-3101',
    orderDate: '2026-09-20',
    projectCode: 'PRJ',
    clientName: 'E2E-Тест Клиент Алия',
    updatedAt: '2026-09-20T09:00:00.000Z',
    sheetMaterials: [],
    films: [],
    ...overrides,
  };
}

describe('resourceDemandLines (адаптер sheetMaterials/films в единые строки)', () => {
  it('листовой материал: source=area, unit=m2, подпись поставщика «Поставщик: X»', () => {
    const row = makeRow({
      sheetMaterials: [
        {
          sheetMaterialTypeId: 55,
          name: 'МДФ 16 Тест',
          totalArea: 8.4,
          detailsCount: 3,
          supplierId: 9,
          supplierName: 'ЛистТорг',
        },
      ],
    });
    const [line] = resourceDemandLines(row);
    expect(line).toMatchObject({
      resourceKey: 'sheet_material:55',
      kind: 'sheet_material',
      refId: 55,
      name: 'МДФ 16 Тест',
      supplierLabel: 'Поставщик: ЛистТорг',
      quantity: 8.4,
      unit: 'm2',
      secondaryText: null,
      detailsCount: 3,
      source: 'area',
    });
  });

  it('листовой материал без поставщика: supplierLabel=null', () => {
    const row = makeRow({
      sheetMaterials: [
        {
          sheetMaterialTypeId: 56,
          name: 'ДСП 18 Тест',
          totalArea: 2.1,
          detailsCount: 1,
          supplierId: null,
          supplierName: null,
        },
      ],
    });
    const [line] = resourceDemandLines(row);
    expect(line.supplierLabel).toBeNull();
  });

  it('плёнка с готовым раскроем: quantity=linearMeters, source=cut, secondaryText — площадь «… м²», подпись производителя', () => {
    const row = makeRow({
      films: [
        {
          filmId: 77,
          name: 'Слоновая кость Тест',
          totalArea: 3.5,
          detailsCount: 5,
          linearMeters: 12.3,
          sheets: 2,
          hasCutData: true,
          vendorId: 11,
          vendorName: 'Фокус прайм',
        },
      ],
    });
    const [line] = resourceDemandLines(row);
    expect(line).toMatchObject({
      resourceKey: 'film:77',
      kind: 'film',
      refId: 77,
      name: 'Слоновая кость Тест',
      supplierLabel: 'Производитель: Фокус прайм',
      quantity: 12.3,
      unit: 'lm',
      detailsCount: 5,
      source: 'cut',
    });
    expect(line.secondaryText).toBe('3,5 м²');
  });

  it('плёнка без готового раскроя: quantity=null, source=none', () => {
    const row = makeRow({
      films: [
        {
          filmId: 78,
          name: 'Олива Тест',
          totalArea: 1.9,
          detailsCount: 2,
          linearMeters: 6.6,
          sheets: 1,
          hasCutData: false,
          vendorId: null,
          vendorName: null,
        },
      ],
    });
    const [line] = resourceDemandLines(row);
    expect(line.quantity).toBeNull();
    expect(line.source).toBe('none');
    expect(line.supplierLabel).toBeNull();
  });

  it('склеивает sheetMaterials и films в одном порядке: сначала листовые, затем плёнки', () => {
    const row = makeRow({
      sheetMaterials: [
        { sheetMaterialTypeId: 1, name: 'Лист А', totalArea: 1, detailsCount: 1, supplierId: null, supplierName: null },
      ],
      films: [
        { filmId: 2, name: 'Плёнка Б', totalArea: 1, detailsCount: 1, linearMeters: 1, sheets: 1, hasCutData: true, vendorId: null, vendorName: null },
      ],
    });
    const lines = resourceDemandLines(row);
    expect(lines.map((l) => l.kind)).toEqual(['sheet_material', 'film']);
  });
});

describe('resourceKindTotal / formatKindTotal', () => {
  const linesMixed: ResourceDemandLine[] = [
    { resourceKey: 'film:1', kind: 'film', refId: 1, name: 'Плёнка 1 Тест', supplierLabel: null, quantity: 4, unit: 'lm', secondaryText: null, detailsCount: 1, source: 'cut' },
    { resourceKey: 'film:2', kind: 'film', refId: 2, name: 'Плёнка 2 Тест', supplierLabel: null, quantity: null, unit: 'lm', secondaryText: null, detailsCount: 1, source: 'none' },
    { resourceKey: 'film:3', kind: 'film', refId: 3, name: 'Плёнка 3 Тест', supplierLabel: null, quantity: 6, unit: 'lm', secondaryText: null, detailsCount: 1, source: 'cut' },
  ];

  it('сумма исключает строки без количества, missingCount их считает', () => {
    const total = resourceKindTotal(linesMixed, 'film');
    expect(total).toEqual({ count: 3, total: 10, missingCount: 1 });
  });

  it('formatKindTotal возвращает "—" когда строк нет вовсе', () => {
    const total = resourceKindTotal([], 'film');
    expect(formatKindTotal(total, 'film')).toBe('—');
  });

  it('formatKindTotal возвращает "—" когда все строки без количества', () => {
    const allMissing: ResourceDemandLine[] = [
      { resourceKey: 'film:9', kind: 'film', refId: 9, name: 'Плёнка 9 Тест', supplierLabel: null, quantity: null, unit: 'lm', secondaryText: null, detailsCount: 1, source: 'none' },
    ];
    const total = resourceKindTotal(allMissing, 'film');
    expect(formatKindTotal(total, 'film')).toBe('—');
  });

  it('formatKindTotal форматирует посчитанный итог с единицей измерения', () => {
    const total = resourceKindTotal(linesMixed, 'film');
    expect(formatKindTotal(total, 'film')).toBe('10,0 пог. м');
  });
});

describe('formatLineQuantity', () => {
  it('плёнка без готового раскроя — "Нет готового раскроя"', () => {
    const line: ResourceDemandLine = {
      resourceKey: 'film:5', kind: 'film', refId: 5, name: 'Плёнка Тест', supplierLabel: null,
      quantity: null, unit: 'lm', secondaryText: null, detailsCount: 1, source: 'none',
    };
    expect(formatLineQuantity(line)).toBe('Нет готового раскроя');
  });

  it('листовой материал без количества — "—" (не плёнка)', () => {
    const line: ResourceDemandLine = {
      resourceKey: 'sheet_material:5', kind: 'sheet_material', refId: 5, name: 'Лист Тест', supplierLabel: null,
      quantity: null, unit: 'm2', secondaryText: null, detailsCount: 1, source: 'none',
    };
    expect(formatLineQuantity(line)).toBe('—');
  });

  it('с количеством — отформатированное число с единицей', () => {
    const line: ResourceDemandLine = {
      resourceKey: 'sheet_material:6', kind: 'sheet_material', refId: 6, name: 'Лист Тест', supplierLabel: null,
      quantity: 12.345, unit: 'm2', secondaryText: null, detailsCount: 1, source: 'area',
    };
    expect(formatLineQuantity(line)).toBe('12,35 м²');
  });
});

describe('positionsLabel (русское склонение)', () => {
  const cases: Array<[number, string]> = [
    [1, '1 позиция'],
    [2, '2 позиции'],
    [3, '3 позиции'],
    [4, '4 позиции'],
    [5, '5 позиций'],
    [11, '11 позиций'],
    [12, '12 позиций'],
    [14, '14 позиций'],
    [21, '21 позиция'],
    [22, '22 позиции'],
  ];

  it.each(cases)('positionsLabel(%i) === %s', (count, expected) => {
    expect(positionsLabel(count)).toBe(expected);
  });
});

describe('orderDisplayName', () => {
  it('обрезает пробелы у имени заказа', () => {
    expect(orderDisplayName(makeRow({ orderId: 10, orderName: '  E2E-Тест 10  ' }))).toBe('E2E-Тест 10');
  });

  it('пустое имя заказа — fallback "#<id>"', () => {
    expect(orderDisplayName(makeRow({ orderId: 11, orderName: '' }))).toBe('#11');
  });

  it('имя из одних пробелов — тоже fallback "#<id>"', () => {
    expect(orderDisplayName(makeRow({ orderId: 12, orderName: '   ' }))).toBe('#12');
  });
});

describe('реестр RESOURCE_KINDS', () => {
  it('типы ресурсов уникальны', () => {
    const kinds = RESOURCE_KINDS.map((meta) => meta.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('буквы типов уникальны', () => {
    const letters = RESOURCE_KINDS.map((meta) => meta.letter);
    expect(new Set(letters).size).toBe(letters.length);
  });
});
