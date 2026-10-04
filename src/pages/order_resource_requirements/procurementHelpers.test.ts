import { describe, expect, it } from 'vitest';

import type {
  OrderResourceCardLineDto,
  OrderResourceDemandDto,
  OrderResourceDemandLineDto,
} from '../../api/types/orderApi.types';
import {
  NO_RESOURCE_CAPABILITIES,
  RESOURCE_PROCUREMENT_BULK_LIMIT,
  canBulkMarkParticipants,
  mapBackendResourceLine,
  procurementMarkedTooltip,
  procurementProgressText,
  resolvePanelSubMode,
  resolveResourceCapabilities,
  resourceDemandLines,
} from './resourceKinds';

function makeBackendLine(overrides: Partial<OrderResourceDemandLineDto> = {}): OrderResourceDemandLineDto {
  return {
    resourceKey: 'sheet_material:55',
    kind: 'sheet_material',
    refId: 55,
    name: 'МДФ 16 Тест',
    supplierName: 'ЛистТорг',
    quantity: 8.4,
    unit: 'm2',
    areaM2: 8.4,
    detailsCount: 3,
    source: 'area',
    demandFingerprint: 'a'.repeat(64),
    orphan: false,
    procurement: {
      purchased: false,
      version: 0,
      origin: null,
      markedAt: null,
      markedBy: null,
      quantityAtMark: null,
      unitAtMark: null,
      changedSinceMark: false,
    },
    ...overrides,
  };
}

function makeRow(overrides: Partial<OrderResourceDemandDto> = {}): OrderResourceDemandDto {
  return {
    orderId: 9001,
    orderName: 'E2E-Тест 9001',
    fullNumber: 'PRJ-9001',
    orderDate: '2026-09-27',
    projectCode: 'PRJ',
    clientName: 'E2E-Тест Клиент',
    updatedAt: '2026-09-27T09:00:00.000Z',
    sheetMaterials: [],
    films: [],
    ...overrides,
  };
}

describe('mapBackendResourceLine (backend lines[] → ResourceDemandLine)', () => {
  it('переносит resourceKey, quantity, unit, source, detailsCount, поставщика, закуп/отпечаток/orphan', () => {
    const line = mapBackendResourceLine(makeBackendLine());
    expect(line).toMatchObject({
      resourceKey: 'sheet_material:55',
      kind: 'sheet_material',
      refId: 55,
      name: 'МДФ 16 Тест',
      supplierLabel: 'Поставщик: ЛистТорг',
      quantity: 8.4,
      unit: 'm2',
      detailsCount: 3,
      source: 'area',
      demandFingerprint: 'a'.repeat(64),
      orphan: false,
    });
    expect(line.procurement).toEqual({
      purchased: false,
      version: 0,
      origin: null,
      markedAt: null,
      markedByName: null,
      quantityAtMark: null,
      changedSinceMark: false,
    });
  });

  it('плёнка: подпись «Производитель», secondaryText — площадь в м²', () => {
    const line = mapBackendResourceLine(makeBackendLine({
      resourceKey: 'film:7', kind: 'film', refId: 7, unit: 'lm', areaM2: 3.5, supplierName: 'Фокус прайм',
    }));
    expect(line.supplierLabel).toBe('Производитель: Фокус прайм');
    expect(line.secondaryText).toBe('3,5 м²');
  });

  it('без поставщика — supplierLabel=null', () => {
    const line = mapBackendResourceLine(makeBackendLine({ supplierName: null }));
    expect(line.supplierLabel).toBeNull();
  });

  it('покрытая отметка закупа: purchased=true, markedByName из markedBy.name', () => {
    const line = mapBackendResourceLine(makeBackendLine({
      procurement: {
        purchased: true,
        version: 3,
        origin: 'manual',
        markedAt: '2026-09-27T10:00:00.000Z',
        markedBy: { userId: 5, name: 'Алия' },
        quantityAtMark: 8.4,
        unitAtMark: 'm2',
        changedSinceMark: true,
      },
    }));
    expect(line.procurement).toMatchObject({
      purchased: true,
      version: 3,
      origin: 'manual',
      markedByName: 'Алия',
      changedSinceMark: true,
    });
  });

  it('карточка (details[]) переносит детали строки', () => {
    const cardLine: OrderResourceCardLineDto = {
      ...makeBackendLine(),
      details: [
        { source: 'detail', id: 1, detailNumber: 3, name: 'Боковина', heightMm: 600, widthMm: 400, quantity: 2 },
        { source: 'hdf', id: 2, detailNumber: null, name: 'ХДФ задняя стенка', heightMm: 500, widthMm: 300, quantity: 1 },
      ],
    };
    const line = mapBackendResourceLine(cardLine);
    expect(line.details).toHaveLength(2);
    expect(line.details?.[1]).toMatchObject({ source: 'hdf', name: 'ХДФ задняя стенка' });
  });

  it('строка без details[] (не карточка) — details остаётся undefined', () => {
    const line = mapBackendResourceLine(makeBackendLine());
    expect(line.details).toBeUndefined();
  });
});

describe('resourceDemandLines — диспетчер lines[] (API v2) vs адаптер sheetMaterials/films (legacy)', () => {
  it('row.lines присутствует → используется напрямую (procurement/demandFingerprint/orphan заполнены)', () => {
    const row = makeRow({ lines: [makeBackendLine()], sheetMaterials: [], films: [] });
    const lines = resourceDemandLines(row);
    expect(lines).toHaveLength(1);
    expect(lines[0].procurement).not.toBeNull();
    expect(lines[0].demandFingerprint).toBe('a'.repeat(64));
  });

  it('row.lines отсутствует (старый backend) → адаптер sheetMaterials/films, procurement не задан', () => {
    const row = makeRow({
      sheetMaterials: [
        { sheetMaterialTypeId: 1, name: 'Лист А', totalArea: 1, detailsCount: 1, supplierId: null, supplierName: null },
      ],
    });
    const lines = resourceDemandLines(row);
    expect(lines).toHaveLength(1);
    expect(lines[0].procurement).toBeUndefined();
    expect(lines[0].demandFingerprint).toBeUndefined();
    expect(lines[0].orphan).toBeUndefined();
  });
});

describe('resolveResourceCapabilities (гейт по capabilities из ответа)', () => {
  it('capabilities отсутствует (старый backend) → все возможности выключены', () => {
    expect(resolveResourceCapabilities(undefined)).toEqual(NO_RESOURCE_CAPABILITIES);
    expect(resolveResourceCapabilities(null)).toEqual(NO_RESOURCE_CAPABILITIES);
  });

  it('capabilities присутствует → возвращается как есть', () => {
    const capabilities = { procurement: true, byMaterial: true, cardDetails: false, onecDocuments: false };
    expect(resolveResourceCapabilities(capabilities)).toEqual(capabilities);
  });
});

describe('canBulkMarkParticipants (лимит групповой отметки закупа)', () => {
  it(`ровно ${RESOURCE_PROCUREMENT_BULK_LIMIT} участников — можно`, () => {
    expect(canBulkMarkParticipants(RESOURCE_PROCUREMENT_BULK_LIMIT)).toBe(true);
  });

  it(`${RESOURCE_PROCUREMENT_BULK_LIMIT + 1} участников — уже нельзя`, () => {
    expect(canBulkMarkParticipants(RESOURCE_PROCUREMENT_BULK_LIMIT + 1)).toBe(false);
  });

  it('0 участников — нельзя (нечего отмечать)', () => {
    expect(canBulkMarkParticipants(0)).toBe(false);
  });

  it('1 участник — можно', () => {
    expect(canBulkMarkParticipants(1)).toBe(true);
  });
});

describe('resolvePanelSubMode (сохранённый подрежим «По материалам» откатывается без возможности)', () => {
  it('capability=true — сохранённый подрежим остаётся', () => {
    expect(resolvePanelSubMode('materials', true)).toBe('materials');
    expect(resolvePanelSubMode('orders', true)).toBe('orders');
  });

  it('capability=false — всегда «По заказам», даже если сохранён «По материалам»', () => {
    expect(resolvePanelSubMode('materials', false)).toBe('orders');
    expect(resolvePanelSubMode('orders', false)).toBe('orders');
  });
});

describe('procurementProgressText / procurementMarkedTooltip', () => {
  it('нет потребности (total=0) — прочерк', () => {
    expect(procurementProgressText({ total: 0, purchased: 0 })).toBe('—');
    expect(procurementProgressText(undefined)).toBe('—');
    expect(procurementProgressText(null)).toBe('—');
  });

  it('прогресс форматируется «Закуплено X из Y»', () => {
    expect(procurementProgressText({ total: 3, purchased: 1 })).toBe('Закуплено 1 из 3');
  });

  it('тултип «Отметил <имя>, <дата>»', () => {
    expect(procurementMarkedTooltip('Алия', '27.09.2026 10:00')).toBe('Отметил Алия, 27.09.2026 10:00');
  });

  it('без имени — «неизвестный пользователь»', () => {
    expect(procurementMarkedTooltip(null, '27.09.2026 10:00')).toBe('Отметил неизвестный пользователь, 27.09.2026 10:00');
  });

  it('нет данных вовсе — null', () => {
    expect(procurementMarkedTooltip(null, null)).toBeNull();
  });
});

describe('данные карточки другого заказа не используются (R1 code review)', () => {
  it('matchingCardData принимает только карточку показанного заказа', async () => {
    const { matchingCardData } = await import('./resourceKinds');
    const card = { orderId: 7, lines: [] };
    expect(matchingCardData(card, 7)).toBe(card);
    expect(matchingCardData(card, 8)).toBeNull();
    expect(matchingCardData(null, 7)).toBeNull();
  });

  it('хук карточки сбрасывает данные прежнего заказа и отдаёт только совпадающие', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./useResourceDemandCard.ts', import.meta.url), 'utf8');
    expect(source).toContain('current && current.orderId === orderId ? current : null');
    expect(source).toContain('response.data.orderId === orderId ? response.data : null');
    expect(source).toContain('data: data && data.orderId === orderId ? data : null');
  });

  it('групповая отметка отключается при фильтрах, которых нет в сводке по материалам', async () => {
    const { readFileSync } = await import('node:fs');
    const aggregate = readFileSync(new URL('./MaterialAggregateView.tsx', import.meta.url), 'utf8');
    const list = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');
    expect(aggregate).toContain("|| blockedReason !== null");
    expect(aggregate).toContain('Сводка по материалам учитывает только поиск, период и «Есть незакупленное»');
    expect(list).toContain('clientFiltersActive={hasActiveListFilters}');
  });
});

describe('групповая отметка только по сводке текущих фильтров (R2 code review)', () => {
  it('isAggregateCurrent: загрузка, чужой ключ или отсутствие данных блокируют отметку', async () => {
    const { isAggregateCurrent } = await import('./resourceKinds');
    expect(isAggregateCurrent(false, '{"dateFrom":"2026-09-01"}', '{"dateFrom":"2026-09-01"}')).toBe(true);
    expect(isAggregateCurrent(true, '{"dateFrom":"2026-09-01"}', '{"dateFrom":"2026-09-01"}')).toBe(false);
    expect(isAggregateCurrent(false, '{"dateFrom":"2026-09-01"}', '{"dateFrom":"2026-09-20"}')).toBe(false);
    expect(isAggregateCurrent(false, null, '{}')).toBe(false);
  });

  it('обработчик клика перепроверяет актуальность сводки перед bulk (клавиатура обходит спиннер)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./MaterialAggregateView.tsx', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('const handleChange = async () => {'));
    expect(handler.indexOf('if (!isCurrent())')).toBeGreaterThan(-1);
    expect(handler.indexOf('if (!isCurrent())')).toBeLessThan(handler.indexOf('bulkSetResourceProcurement'));
    expect(source).toContain(": !state.current ? 'Сводка обновляется по новым фильтрам' : null");
  });
});

describe('период «По материалам» по умолчанию — последний месяц', () => {
  it('без выбранных дат берёт последний месяц и помечает его как умолчание', async () => {
    const { resolveByMaterialPeriod } = await import('./resourceKinds');
    expect(resolveByMaterialPeriod(undefined, undefined, '2026-08-28', '2026-09-28'))
      .toEqual({ dateFrom: '2026-08-28', dateTo: '2026-09-28', isDefault: true });
  });

  it('выбранный пользователем период важнее, даже если задан только один край', async () => {
    const { resolveByMaterialPeriod } = await import('./resourceKinds');
    expect(resolveByMaterialPeriod('2026-09-01', '2026-09-10', '2026-08-28', '2026-09-28'))
      .toEqual({ dateFrom: '2026-09-01', dateTo: '2026-09-10', isDefault: false });
    expect(resolveByMaterialPeriod('2026-09-01', undefined, '2026-08-28', '2026-09-28'))
      .toEqual({ dateFrom: '2026-09-01', isDefault: false });
  });

  it('список строит запрос сводки из этого периода и показывает подсказку', async () => {
    const { readFileSync } = await import('node:fs');
    const list = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');
    expect(list).toContain("dayjs(todayKey).subtract(1, 'month').format('YYYY-MM-DD')");
    expect(list).toContain('byMaterialPeriodNote={byMaterialPeriodNote}');
    expect(list).toContain('Период по умолчанию — последний месяц');
  });
});

describe('сводка «По материалам»: склонение и итог без данных', () => {
  it('ordersLabel склоняет «заказ»', async () => {
    const { ordersLabel } = await import('./resourceKinds');
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25, 101].map(ordersLabel)).toEqual([
      '1 заказ', '2 заказа', '4 заказа', '5 заказов', '11 заказов', '12 заказов',
      '21 заказ', '22 заказа', '25 заказов', '101 заказ',
    ]);
  });

  it('итог «—», если количество не посчитано ни в одном заказе; иначе сумма известных', async () => {
    const { formatAggregateTotal, formatResourceQuantity } = await import('./resourceKinds');
    expect(formatAggregateTotal({ totalQuantity: 0, unit: 'lm', ordersCount: 1, noDataOrders: 1 })).toBe('—');
    expect(formatAggregateTotal({ totalQuantity: 3.1, unit: 'lm', ordersCount: 2, noDataOrders: 1 }))
      .toBe(formatResourceQuantity(3.1, 'lm'));
    expect(formatAggregateTotal({ totalQuantity: 9.49, unit: 'm2', ordersCount: 3, noDataOrders: 0 }))
      .toBe(formatResourceQuantity(9.49, 'm2'));
  });
});
