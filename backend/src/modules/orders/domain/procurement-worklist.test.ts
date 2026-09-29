import { describe, expect, it } from 'vitest';
import type { ProcurementWorklistLineDto } from '../application/procurement-workspace.types';
import {
  computeCoverage,
  groupLines,
  matchesPreset,
  matchesQuery,
  resolveSupplier,
  sheetAreaM2,
  sortLines,
  subtractWorkingDays,
  toDemandUnit,
  toDocUnitFloor,
  todayInAlmaty,
  urgencyOf,
  type CoverageInput,
} from './procurement-worklist';

const base: CoverageInput = {
  need: 10,
  received: 0,
  purchased: false,
  origin: null,
  hasActiveReceipts: false,
  demandChangedSinceMark: false,
  quantityAtMark: null,
  orderedOpen: 0,
};

describe('computeCoverage — таблица примеров плана §4.1', () => {
  it.each([
    ['не отмечено, ничего не пришло', base, { covered: 0, deficit: 10, coverage: 'none' }],
    ['ручная отметка без приходов', { ...base, purchased: true, origin: 'manual', quantityAtMark: 10 }, { covered: 10, deficit: 0, coverage: 'covered' }],
    ['потребность выросла после ручной отметки — дефицит только прирост',
      { ...base, need: 14, purchased: true, origin: 'manual', quantityAtMark: 10, demandChangedSinceMark: true },
      { covered: 10, deficit: 4, coverage: 'partial' }],
    ['отметка приходом, пришло 6', { ...base, purchased: true, origin: 'onec', received: 6, hasActiveReceipts: true }, { covered: 6, deficit: 4, coverage: 'partial' }],
    ['заявлено всё, не пришло', { ...base, orderedOpen: 10 }, { covered: 0, deficit: 0, coverage: 'ordered' }],
  ] as const)('%s', (_name, input, expected) => {
    expect(computeCoverage(input as CoverageInput)).toMatchObject(expected);
  });

  it('нет данных о потребности — no_data, не требует действия', () => {
    expect(computeCoverage({ ...base, need: null })).toEqual({ covered: 0, deficit: null, coverage: 'no_data', needsAction: false });
  });

  it('R4-3: «не отмечено → приход 6 → снятие прихода» — дефицит 10, а не 0', () => {
    // После снятия прихода флаг остаётся (контракт ф.3), источник — onec, активных приходов нет.
    expect(computeCoverage({ ...base, purchased: true, origin: 'onec', received: 0, hasActiveReceipts: false }))
      .toMatchObject({ covered: 0, deficit: 10, coverage: 'none', needsAction: true });
  });

  it('CR1-1: отметка без количества (до раскроя), потом появилась потребность — покрытия нет, нужно подтвердить', () => {
    expect(computeCoverage({ ...base, purchased: true, origin: 'manual', quantityAtMark: null, demandChangedSinceMark: true }))
      .toMatchObject({ covered: 0, deficit: 10, needsAction: true });
    // Без изменения потребности ручная отметка по-прежнему покрывает.
    expect(computeCoverage({ ...base, purchased: true, origin: 'manual', quantityAtMark: null }))
      .toMatchObject({ covered: 10, deficit: 0 });
  });

  it('ручная отметка при наличии приходов не покрывает — считаются приходы', () => {
    expect(computeCoverage({ ...base, purchased: true, origin: 'manual', received: 3, hasActiveReceipts: true }))
      .toMatchObject({ covered: 3, deficit: 7 });
  });

  it('считает в тысячных без погрешностей float', () => {
    expect(computeCoverage({ ...base, need: 0.3, received: 0.1, orderedOpen: 0.2 })).toMatchObject({ deficit: 0, coverage: 'ordered' });
  });
});

describe('единицы (§4.4)', () => {
  const geometry = { sheetAreaM2: sheetAreaM2(2500, 2000) };

  it('лист ↔ м² по размеру листа', () => {
    expect(geometry.sheetAreaM2).toBe(5);
    expect(toDemandUnit(2, 'sheet', 'm2', geometry)).toBe(10);
    // Пример из ревью: дефицит 10 м², лист 5 м² → 2 листа.
    expect(toDocUnitFloor(10, 'm2', 'sheet', geometry)).toBe(2);
  });

  it('округляет вниз после перевода в единицу строки', () => {
    expect(toDocUnitFloor(10.0049, 'm2', 'sheet', geometry)).toBe(2);
    expect(toDocUnitFloor(1.23456, 'm2', 'm2', geometry)).toBe(1.234);
  });

  it('несовместимые единицы и материал без размеров → null', () => {
    expect(toDemandUnit(3, 'pcs', 'm2', geometry)).toBeNull();
    expect(toDemandUnit(3, 'm2', 'lm', geometry)).toBeNull();
    expect(toDemandUnit(3, 'sheet', 'm2', { sheetAreaM2: null })).toBeNull();
    expect(sheetAreaM2(null, 2000)).toBeNull();
  });
});

describe('срок и срочность (§4.2)', () => {
  it('вычитает рабочие дни, пропуская выходные', () => {
    expect(subtractWorkingDays('2026-10-05', 2)).toBe('2026-10-01'); // пн − 2 раб. = чт
    expect(subtractWorkingDays('2026-10-01', 0)).toBe('2026-10-01');
  });

  it('границы порогов 3/7 и просрочка', () => {
    const t = { criticalDays: 3, soonDays: 7 };
    expect(urgencyOf('2026-09-27', '2026-09-28', t)).toEqual({ urgency: 'overdue', daysLeft: -1 });
    expect(urgencyOf('2026-10-01', '2026-09-28', t)).toEqual({ urgency: 'critical', daysLeft: 3 });
    expect(urgencyOf('2026-10-05', '2026-09-28', t)).toEqual({ urgency: 'soon', daysLeft: 7 });
    expect(urgencyOf('2026-10-06', '2026-09-28', t)).toEqual({ urgency: 'normal', daysLeft: 8 });
    expect(urgencyOf(null, '2026-09-28', t)).toEqual({ urgency: 'no_date', daysLeft: null });
  });

  it('сегодня — по Asia/Almaty', () => {
    expect(todayInAlmaty(new Date('2026-09-28T20:30:00.000Z'))).toBe('2026-09-29');
  });
});

describe('поставщик (§4.3)', () => {
  const recorded = [
    { key: 's:2', name: 'Kronospan', firstSeenAt: '2026-09-20T00:00:00Z', id: 5 },
    { key: 's:1', name: 'Мебель-Трейд', firstSeenAt: '2026-09-10T00:00:00Z', id: 9 },
  ];

  it('ручной из справочника материала важнее записанных', () => {
    expect(resolveSupplier({ id: 2, name: 'Kronospan' }, recorded)).toEqual({
      key: 's:2', name: 'Kronospan', source: 'material', others: [{ key: 's:1', name: 'Мебель-Трейд' }],
    });
  });

  it('иначе — первый записанный, последующие его не затирают', () => {
    expect(resolveSupplier(null, recorded)).toEqual({
      key: 's:1', name: 'Мебель-Трейд', source: 'first_receipt', others: [{ key: 's:2', name: 'Kronospan' }],
    });
  });

  it('никого — «Не указан»', () => {
    expect(resolveSupplier(null, [])).toMatchObject({ key: 'none', source: 'none' });
  });
});

function line(overrides: Partial<ProcurementWorklistLineDto>): ProcurementWorklistLineDto {
  return {
    lineKey: '1|sheet_material:1', orderId: 1, orderName: '2972', fullNumber: 'A-2972', clientName: 'Клиент',
    orderStatus: null, resourceKey: 'sheet_material:1', kind: 'sheet_material', refId: 1, name: 'МДФ 16мм',
    unit: 'm2', demandSource: 'cut', need: 10, received: 0, receivedIncompatibleCount: 0, covered: 0, orderedOpen: 0, deficit: 10,
    coverage: 'none', needsAction: true, purchased: false, purchaseOrigin: null, demandChangedSinceMark: false,
    plannedCompletionDate: '2026-10-02', dueDate: '2026-09-30', daysLeft: 2, urgency: 'critical',
    supplier: { key: 's:1', name: 'Мебель-Трейд', source: 'material', others: [] },
    procurementVersion: 0, demandFingerprint: 'f'.repeat(64), onecReceiptCount: 0, lockedByOnec: false,
    ...overrides,
  };
}

describe('фильтры, пресеты, сортировка, группы', () => {
  it('пресеты: требует действия и срочно', () => {
    expect(matchesPreset(line({}), 'urgent')).toBe(true);
    expect(matchesPreset(line({ urgency: 'normal' }), 'urgent')).toBe(false);
    expect(matchesPreset(line({ needsAction: false }), 'action')).toBe(false);
    expect(matchesPreset(line({ needsAction: false }), 'all')).toBe(true);
  });

  it('поиск по заказу, клиенту, материалу и поставщику', () => {
    const q = { preset: 'all', groupBy: 'none', sort: 'due' } as const;
    expect(matchesQuery(line({}), { ...q, search: 'мдф' })).toBe(true);
    expect(matchesQuery(line({}), { ...q, search: 'мебель' })).toBe(true);
    expect(matchesQuery(line({}), { ...q, search: 'плёнка' })).toBe(false);
    expect(matchesQuery(line({ dueDate: null }), { ...q, dueFrom: '2026-09-01' })).toBe(false);
  });

  it('сортировка по сроку: просрочено, затем по дате, без даты — в конце', () => {
    const sorted = sortLines([
      line({ lineKey: 'a', urgency: 'no_date', dueDate: null }),
      line({ lineKey: 'b', urgency: 'soon', dueDate: '2026-10-04' }),
      line({ lineKey: 'c', urgency: 'overdue', dueDate: '2026-09-20' }),
    ], 'due');
    expect(sorted.map((l) => l.lineKey)).toEqual(['c', 'b', 'a']);
  });

  it('группы по поставщику с суммой дефицита по единицам, «Не указан» — последней', () => {
    const groups = groupLines([
      line({ lineKey: 'a', deficit: 1.1 }),
      line({ lineKey: 'b', deficit: 2.2 }),
      line({ lineKey: 'c', unit: 'lm', kind: 'film', deficit: 3, supplier: { key: 'none', name: 'Не указан', source: 'none', others: [] } }),
    ], 'supplier');
    expect(groups).toEqual([
      { key: 's:1', label: 'Мебель-Трейд', linesCount: 2, deficitM2: 3.3, deficitLm: 0, lineKeys: ['a', 'b'] },
      { key: 'none', label: 'Не указан', linesCount: 1, deficitM2: 0, deficitLm: 3, lineKeys: ['c'] },
    ]);
  });
});
