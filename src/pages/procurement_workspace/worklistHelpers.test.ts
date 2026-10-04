import { describe, expect, it } from 'vitest';
import type { ProcurementWorklistLine } from '../../api/types/procurementWorkspaceApi.types';
import { resolveSupplyTab } from '../order_resource_requirements/resourceRequirementsTabs';
import {
  DEFAULT_WORKLIST_STATE,
  applySelectionChange,
  areAllGroupsCollapsed,
  isLegendCoverageActive,
  loadCollapsedGroups,
  saveCollapsedGroups,
  toggleCollapsedGroup,
  toggleCoverageValue,
  toggleLegendCoverage,
  bulkMarkBlockReason,
  clampPage,
  dueText,
  isGroupSelected,
  parseWorklistSearch,
  planBulkMarks,
  stateFromViewQuery,
  stateToViewQuery,
  toApiParams,
  toggleGroupSelection,
  worklistExportRows,
  writeWorklistSearch,
} from './worklistHelpers';

function line(overrides: Partial<ProcurementWorklistLine>): ProcurementWorklistLine {
  return {
    lineKey: '1|sheet_material:8', orderId: 1, orderName: '2972', fullNumber: 'A-2972', clientName: 'Клиент', orderStatus: null,
    resourceKey: 'sheet_material:8', kind: 'sheet_material', refId: 8, name: 'МДФ 16мм', unit: 'm2', demandSource: 'cut', need: 10, received: 0,
    receivedIncompatibleCount: 0, covered: 0, orderedOpen: 0, requests: [], deficit: 10, coverage: 'none', needsAction: true, purchased: false,
    purchaseOrigin: null, demandChangedSinceMark: false, plannedCompletionDate: '2026-10-02', dueDate: '2026-09-30', daysLeft: 2,
    urgency: 'critical', supplier: { key: 's:1', name: 'Мебель-Трейд', source: 'material', others: [] },
    procurementVersion: 3, demandFingerprint: 'a'.repeat(64), onecReceiptCount: 0, lockedByOnec: false,
    ...overrides,
  };
}

describe('состояние рабочего списка в адресе', () => {
  it('по умолчанию — «Требует действия», без группировки, по сроку', () => {
    expect(parseWorklistSearch(new URLSearchParams())).toEqual(DEFAULT_WORKLIST_STATE);
  });

  it('пишет только отличия от умолчаний и сохраняет чужие параметры', () => {
    const current = new URLSearchParams('tab=supply&onecDocumentId=5');
    const next = writeWorklistSearch(current, { ...DEFAULT_WORKLIST_STATE, preset: 'urgent', groupBy: 'supplier', coverage: ['none', 'partial'], search: ' 2972 ' });
    expect(next.get('tab')).toBe('supply');
    expect(next.get('onecDocumentId')).toBe('5');
    expect(next.get('preset')).toBe('urgent');
    expect(next.get('sort')).toBeNull();
    expect(next.get('q')).toBe('2972');
    expect(parseWorklistSearch(next)).toMatchObject({ preset: 'urgent', groupBy: 'supplier', coverage: ['none', 'partial'], search: '2972' });
  });

  it('отбрасывает мусор из адреса', () => {
    expect(parseWorklistSearch(new URLSearchParams('preset=hot&dueFrom=31.12.2026&coverage=x,none&wlDoc=-1&supplier=zz')))
      .toMatchObject({ preset: 'action', dueFrom: null, coverage: ['none'], onecDocumentId: null, supplierKey: null });
  });

  it('представление — это query только рабочего списка, туда и обратно', () => {
    const state = { ...DEFAULT_WORKLIST_STATE, preset: 'urgent' as const, supplierKey: 's:1', kind: 'film' as const };
    expect(stateFromViewQuery(stateToViewQuery(state))).toEqual(state);
    expect(stateToViewQuery(state)).not.toContain('tab=');
  });

  it('параметры API без пустых значений', () => {
    expect(toApiParams({ ...DEFAULT_WORKLIST_STATE, search: '  ' })).toEqual({ preset: 'action', groupBy: 'none', sort: 'due' });
  });
});

describe('«Выделить группу» ↔ «Снять выделение»', () => {
  it('переключает выделение всей группы и не трогает остальные строки', () => {
    const selected = new Set(['other']);
    const once = toggleGroupSelection(['a', 'b'], selected);
    expect([...once].sort()).toEqual(['a', 'b', 'other']);
    expect(isGroupSelected(['a', 'b'], once)).toBe(true);
    const twice = toggleGroupSelection(['a', 'b'], once);
    expect([...twice]).toEqual(['other']);
    expect(isGroupSelected([], new Set())).toBe(false);
  });
});

describe('групповая отметка «Закуплено» по материалам (R1-10)', () => {
  it('разбивает выделение по материалам, пропуская уже отмеченные', () => {
    const plan = planBulkMarks([
      line({ lineKey: 'a', orderId: 2 }),
      line({ lineKey: 'b', orderId: 1 }),
      line({ lineKey: 'c', orderId: 3, resourceKey: 'film:4', name: 'Плёнка', kind: 'film' }),
      line({ lineKey: 'd', orderId: 4, purchased: true }),
    ]);
    expect(plan.alreadyPurchased).toBe(1);
    expect(plan.requests.map((request) => [request.resourceKey, request.items.map((item) => item.orderId)]))
      .toEqual([['film:4', [3]], ['sheet_material:8', [1, 2]]]);
    expect(plan.requests[1].items[0]).toEqual({ orderId: 1, expectedVersion: 3, expectedDemandFingerprint: 'a'.repeat(64) });
  });

  it('больше 100 заказов одного материала — не отправляется, а объясняется', () => {
    const many = Array.from({ length: 101 }, (_, index) => line({ lineKey: String(index), orderId: index + 1 }));
    const plan = planBulkMarks(many);
    expect(plan.requests).toEqual([]);
    expect(plan.tooLarge).toEqual([{ resourceKey: 'sheet_material:8', materialName: 'МДФ 16мм', count: 101 }]);
  });
});

describe('подписи и выгрузка', () => {
  it('срок — «Срочно» в словах, без «Горит»', () => {
    expect(dueText({ daysLeft: -2, urgency: 'overdue' })).toBe('просрочено на 2 дн.');
    expect(dueText({ daysLeft: 0, urgency: 'critical' })).toBe('сегодня');
    expect(dueText({ daysLeft: null, urgency: 'no_date' })).toBe('без срока');
  });

  it('строки Excel', () => {
    expect(worklistExportRows([line({ purchased: true, purchaseOrigin: 'onec' })])[0]).toMatchObject({
      'Заказ': 'A-2972', 'Дефицит': 10, 'Ед.': 'м²', 'Обеспечено': 'Не покрыто', 'Закуплено': 'приходом 1С',
    });
  });
});

describe('вкладки страницы', () => {
  it('«Экран снабжения» — только когда доступен', () => {
    expect(resolveSupplyTab('supply', true)).toBe('supply');
    expect(resolveSupplyTab('supply', false)).toBe('demand');
    expect(resolveSupplyTab(null, true)).toBe('demand');
  });
});

describe('CR1: выделение и блокировка групповых действий', () => {
  it('диапазон Shift снимается так же, как ставится; остальные строки сохраняются', () => {
    const selected = applySelectionChange(new Set(['other']), ['a', 'b', 'c'], true);
    expect([...selected].sort()).toEqual(['a', 'b', 'c', 'other']);
    expect([...applySelectionChange(selected, ['a', 'b'], false)].sort()).toEqual(['c', 'other']);
  });

  it('групповая отметка недоступна, пока список не совпадает с фильтрами', () => {
    const plan = planBulkMarks([line({})]);
    expect(bulkMarkBlockReason({ stale: true, canManage: true, manageLoading: false, plan })).toMatch(/обновляется/);
    expect(bulkMarkBlockReason({ stale: false, canManage: true, manageLoading: false, plan })).toBeNull();
  });

  it('больше 100 заказов одного материала — кнопка недоступна с объяснением ещё до подтверждения', () => {
    const many = Array.from({ length: 101 }, (_, index) => line({ lineKey: String(index), orderId: index + 1 }));
    const mixed = [...many, line({ lineKey: 'f', orderId: 999, resourceKey: 'film:4', name: 'Плёнка' })];
    expect(bulkMarkBlockReason({ stale: false, canManage: true, manageLoading: false, plan: planBulkMarks(mixed) }))
      .toMatch(/МДФ 16мм — 101/);
  });

  it('права: загрузка — не «нет права»', () => {
    const plan = planBulkMarks([line({})]);
    expect(bulkMarkBlockReason({ stale: false, canManage: false, manageLoading: true, plan })).toBe('Загружаются права');
    expect(bulkMarkBlockReason({ stale: false, canManage: false, manageLoading: false, plan })).toMatch(/procurement\.manage/);
  });
});

describe('CR1-4: вкладка настроек показывает ошибку загрузки, а не вечный спиннер', () => {
  it('ошибка проверяется раньше спиннера', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/pages/configuration/components/ProcurementSettingsTab.tsx', 'utf8');
    expect(source.indexOf('if (loadError && !loading)')).toBeGreaterThan(-1);
    expect(source.indexOf('if (loadError && !loading)')).toBeLessThan(source.indexOf('if (loading || !values)'));
  });
});

describe('CR3-2: страница после сокращения списка', () => {
  it('ограничивается последней существующей', () => {
    expect(clampPage(2, 50, 50)).toBe(1);
    expect(clampPage(2, 60, 50)).toBe(2);
    expect(clampPage(3, 0, 50)).toBe(1);
  });
});

describe('замечания 2026-10-04: легенда-фильтры, чипы «Обеспечено», сворачивание групп', () => {
  it('пункт легенды включает свой фильтр, повторный клик снимает', () => {
    expect(toggleLegendCoverage({ coverage: [], preset: 'action' }, 'deficit')).toEqual({ coverage: ['partial', 'none'] });
    expect(isLegendCoverageActive(['none', 'partial'], 'deficit')).toBe(true);
    expect(toggleLegendCoverage({ coverage: ['none', 'partial'], preset: 'action' }, 'deficit')).toEqual({ coverage: [] });
    expect(isLegendCoverageActive(['none'], 'deficit')).toBe(false);
  });

  it('«пришло» переводит набор на «Всё»: полностью пришедшие позиции действий не требуют', () => {
    expect(toggleLegendCoverage({ coverage: [], preset: 'action' }, 'received')).toEqual({ coverage: ['covered'], preset: 'all' });
    expect(toggleLegendCoverage({ coverage: [], preset: 'all' }, 'received')).toEqual({ coverage: ['covered'] });
    expect(toggleLegendCoverage({ coverage: [], preset: 'urgent' }, 'ordered')).toEqual({ coverage: ['ordered'] });
  });

  it('чип значения добавляет и убирает одно значение, порядок постоянный', () => {
    expect(toggleCoverageValue(['covered'], 'none')).toEqual(['none', 'covered']);
    expect(toggleCoverageValue(['none', 'covered'], 'covered')).toEqual(['none']);
  });

  it('«Свернуть все» становится «Развернуть все», только когда свёрнуты все показанные группы', () => {
    expect(areAllGroupsCollapsed([], new Set())).toBe(false);
    expect(areAllGroupsCollapsed(['a', 'b'], new Set(['a']))).toBe(false);
    expect(areAllGroupsCollapsed(['a', 'b'], new Set(['a', 'b', 'old']))).toBe(true);
    expect([...toggleCollapsedGroup(new Set(['a']), 'b')]).toEqual(['a', 'b']);
    expect([...toggleCollapsedGroup(new Set(['a']), 'a')]).toEqual([]);
  });
});

describe('свёрнутые группы запоминаются для пользователя по каждой группировке', () => {
  const storage = () => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  };

  it('сохранённое состояние возвращается; у другого пользователя и другой группировки — своё', () => {
    const store = storage();
    saveCollapsedGroups('42', 'supplier', new Set(['s:1', 'none']), store);
    expect([...loadCollapsedGroups('42', 'supplier', store)]).toEqual(['s:1', 'none']);
    expect(loadCollapsedGroups('42', 'material', store).size).toBe(0);
    expect(loadCollapsedGroups('43', 'supplier', store).size).toBe(0);
    // «Развернуть все» — запись убирается.
    saveCollapsedGroups('42', 'supplier', new Set(), store);
    expect(store.data.size).toBe(0);
  });

  it('испорченная запись или недоступное хранилище — всё развёрнуто, без ошибок', () => {
    const store = storage();
    store.setItem('procurement.worklist.collapsedGroups.42.supplier', '{oops');
    expect(loadCollapsedGroups('42', 'supplier', store).size).toBe(0);
    store.setItem('procurement.worklist.collapsedGroups.42.supplier', '["a", 5, null]');
    expect([...loadCollapsedGroups('42', 'supplier', store)]).toEqual(['a']);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(loadCollapsedGroups('42', 'supplier', broken).size).toBe(0);
    expect(() => saveCollapsedGroups('42', 'supplier', new Set(['a']), broken)).not.toThrow();
  });
});
