import { afterEach, describe, expect, it } from 'vitest';
import type { OrderResourceDemandDto } from '../../api/types/orderApi.types';
import { buildMaterialRowsItems } from './MaterialRowsView';
import { kindSource } from './ResourceDemandCard';
import { isDarkColor } from './ResourceDemandParts';
import { readStoredViewMode, viewModeStorageKey } from './useStoredViewMode';
import type { ResourceDemandLine, ResourceKind } from './resourceKinds';

function makeRow(overrides: Partial<OrderResourceDemandDto> = {}): OrderResourceDemandDto {
  return {
    orderId: 4201,
    orderName: 'E2E-Тест 4201',
    fullNumber: 'PRJ-4201',
    orderDate: '2026-09-21',
    projectCode: 'PRJ',
    clientName: 'E2E-Тест Клиент Руслан',
    updatedAt: '2026-09-21T09:00:00.000Z',
    sheetMaterials: [],
    films: [],
    ...overrides,
  };
}

const ALL_KINDS: Set<ResourceKind> = new Set(['sheet_material', 'film']);

describe('buildMaterialRowsItems (вид «Материалы»)', () => {
  const rowA = makeRow({
    orderId: 4201,
    orderName: 'E2E-Тест 4201',
    sheetMaterials: [
      { sheetMaterialTypeId: 1, name: 'МДФ Тест А', totalArea: 5, detailsCount: 2, supplierId: null, supplierName: null },
    ],
    films: [
      { filmId: 2, name: 'Плёнка Тест А', totalArea: 2, detailsCount: 1, linearMeters: 4, sheets: 1, hasCutData: true, vendorId: null, vendorName: null },
    ],
  });
  const rowB = makeRow({
    orderId: 4202,
    orderName: 'E2E-Тест 4202',
    sheetMaterials: [
      { sheetMaterialTypeId: 3, name: 'ДСП Тест Б', totalArea: 3, detailsCount: 1, supplierId: null, supplierName: null },
    ],
    films: [],
  });

  it('строит один group-элемент на заказ, за которым идут его line-элементы', () => {
    const items = buildMaterialRowsItems([rowA, rowB], ALL_KINDS, new Set());
    expect(items.map((item) => item.type)).toEqual(['group', 'line', 'line', 'group', 'line']);
    expect(items[0]).toMatchObject({ type: 'group', key: 'order:4201' });
    expect(items[1]).toMatchObject({ type: 'line', key: 'order:4201:sheet_material:1' });
    expect(items[2]).toMatchObject({ type: 'line', key: 'order:4201:film:2' });
    expect(items[3]).toMatchObject({ type: 'group', key: 'order:4202' });
    expect(items[4]).toMatchObject({ type: 'line', key: 'order:4202:sheet_material:3' });
  });

  it('свёрнутый заказ отдаёт только group-элемент, без line-элементов', () => {
    const items = buildMaterialRowsItems([rowA, rowB], ALL_KINDS, new Set([4201, 4202]));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'group', key: 'order:4201' });
    expect(items[1]).toMatchObject({ type: 'group', key: 'order:4202' });
  });

  it('не свёрнутый заказ рядом со свёрнутым — свёрнутый без строк, остальные заказы со своими строками', () => {
    const items = buildMaterialRowsItems([rowA, rowB], ALL_KINDS, new Set([4201]));
    expect(items.map((item) => item.key)).toEqual([
      'order:4201',
      'order:4202',
      'order:4202:sheet_material:3',
    ]);
  });

  it('скрытые типы фильтруются из line-элементов, но group-элемент остаётся', () => {
    const visibleKinds = new Set<ResourceKind>(['sheet_material']);
    const items = buildMaterialRowsItems([rowA], visibleKinds, new Set());
    expect(items.map((item) => item.type)).toEqual(['group', 'line']);
    expect(items[0]).toMatchObject({ type: 'group', key: 'order:4201' });
    // group item keeps both lines internally for totals, even though film is hidden
    if (items[0].type === 'group') {
      expect(items[0].lines.map((line) => line.kind)).toEqual(['sheet_material', 'film']);
    }
    expect(items[1]).toMatchObject({ type: 'line', key: 'order:4201:sheet_material:1' });
  });
});

describe('kindSource (худший источник среди строк типа)', () => {
  const line = (source: ResourceDemandLine['source']): ResourceDemandLine => ({
    resourceKey: `film:${source}`,
    kind: 'film',
    refId: 1,
    name: 'Плёнка Тест',
    supplierLabel: null,
    quantity: source === 'none' ? null : 1,
    unit: 'lm',
    secondaryText: null,
    detailsCount: 1,
    source,
  });

  it('только «по раскрою» — cut', () => {
    expect(kindSource([line('cut')], 'film')).toBe('cut');
  });

  it('«по площади» перекрывает «по раскрою» — area', () => {
    expect(kindSource([line('cut'), line('area')], 'film')).toBe('area');
  });

  it('«нет раскроя» перекрывает всё остальное — none', () => {
    expect(kindSource([line('cut'), line('area'), line('none')], 'film')).toBe('none');
  });
});

describe('isDarkColor', () => {
  it('тёмный фон (#141414) — true', () => {
    expect(isDarkColor('#141414')).toBe(true);
  });

  it('светлый фон (#ffffff) — false', () => {
    expect(isDarkColor('#ffffff')).toBe(false);
  });

  it('некорректная строка цвета — false', () => {
    expect(isDarkColor('not-a-color')).toBe(false);
  });
});

describe('viewModeStorageKey', () => {
  it('формирует ключ как erp.viewMode.<user>.<key>', () => {
    expect(viewModeStorageKey('78', 'order-resource-requirements:list-view')).toBe(
      'erp.viewMode.78.order-resource-requirements:list-view',
    );
  });
});

describe('readStoredViewMode', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    } else {
      // @ts-expect-error test cleanup — no localStorage existed before this suite
      delete globalThis.localStorage;
    }
  });

  function stubLocalStorage(getItem: (key: string) => string | null) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem, setItem: () => {} },
    });
  }

  it('возвращает сохранённое разрешённое значение', () => {
    stubLocalStorage((key) => (key === 'erp.viewMode.78.list-view' ? 'materials' : null));
    expect(readStoredViewMode('erp.viewMode.78.list-view', ['summary', 'materials', 'panel'] as const)).toBe('materials');
  });

  it('возвращает null для неразрешённого значения', () => {
    stubLocalStorage(() => 'not-an-allowed-mode');
    expect(readStoredViewMode('erp.viewMode.78.list-view', ['summary', 'materials', 'panel'] as const)).toBeNull();
  });

  it('возвращает null, если значение отсутствует', () => {
    stubLocalStorage(() => null);
    expect(readStoredViewMode('erp.viewMode.78.list-view', ['summary', 'materials', 'panel'] as const)).toBeNull();
  });

  it('возвращает null, если localStorage.getItem бросает исключение', () => {
    stubLocalStorage(() => {
      throw new Error('Storage недоступен (приватный режим)');
    });
    expect(readStoredViewMode('erp.viewMode.78.list-view', ['summary', 'materials', 'panel'] as const)).toBeNull();
  });
});
