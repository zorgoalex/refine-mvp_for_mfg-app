import { describe, expect, it, vi } from 'vitest';
import type { CutOrderJobIssues } from '../../../../api/types/cutApi.types';
import {
  columnCutIssueJobs,
  columnCutIssuesTitle,
  orderCutColumnRefsKey,
  orderCutIssueLines,
  orderCutIssuesDetailsKey,
  orderCutJobStatus,
  startOrderCutIssuesRefresh,
} from './OrderCutIssuesAlert';

const job = (overrides: Partial<CutOrderJobIssues> = {}): CutOrderJobIssues => ({
  cutJobId: 1028, cutNumber: '411', name: 'Тест', isVacuum: false, requiresRecalc: false,
  issues: [{ kind: 'deleted', orderDetailId: 68666, detailNumber: 3, calculated: null, current: null }],
  ...overrides,
});

describe('order cut issue lines', () => {
  it('groups issues by kind in a fixed order and shows before/after values and the target order', () => {
    expect(orderCutIssueLines(job({
      issues: [
        { kind: 'size_changed', orderDetailId: 5, detailNumber: 5, calculated: '700×596', current: '700×600' },
        { kind: 'moved', orderDetailId: 66561, detailNumber: 32, calculated: null, current: '3065' },
        { kind: 'deleted', orderDetailId: 68666, detailNumber: 3, calculated: null, current: null },
        { kind: 'deleted', orderDetailId: 68667, detailNumber: null, calculated: null, current: null },
        { kind: 'material_changed', orderDetailId: 6, detailNumber: 6, calculated: null, current: null },
      ],
    }))).toEqual([
      'удалены из заказа: №3, id 68667',
      'перенесены в другой заказ: №32 → заказ 3065',
      'изменён размер: №5 (было 700×596, стало 700×600)',
      'изменён материал листа: №6',
    ]);
  });
});

describe('column cuts', () => {
  const columnIds = new Set([1028, 2000]);

  it('keeps only jobs a detail column points at that have issues', () => {
    const jobs = [
      job(),
      job({ cutJobId: 2000, isVacuum: true, cutNumber: 'В-679', issues: [] }),
      job({ cutJobId: 722, cutNumber: '294', requiresRecalc: true }),
    ];
    expect(columnCutIssueJobs(jobs, columnIds).map((item) => item.cutJobId)).toEqual([1028]);
  });

  it('names cuts and baths in the title', () => {
    expect(columnCutIssuesTitle([job()])).toBe('Раскрой из колонки «Раскрой» не актуален: после расчёта детали заказа удалили или изменили');
    expect(columnCutIssuesTitle([job({ isVacuum: true, cutNumber: 'В-679' })])).toBe('Ванна из колонки «Ванна» не актуальна: после расчёта детали заказа удалили или изменили');
    expect(columnCutIssuesTitle([job(), job({ cutJobId: 2000, isVacuum: true })])).toBe('Раскрои и ванны из колонок «Раскрой» / «Ванна» не актуальны: после расчёта детали заказа удалили или изменили');
  });

  it('explains why a listed job is not in the details columns', () => {
    expect(orderCutJobStatus(job(), true)).toContain('указан в колонке деталей');
    expect(orderCutJobStatus(job({ requiresRecalc: true, issues: [] }), false)).toContain('детали переносились между заказами');
    expect(orderCutJobStatus(job({ requiresRecalc: true }), false)).toContain('ждёт пересчёта');
    // every detail of this order in the job deleted, no newer cut: no claim about a replacement
    expect(orderCutJobStatus(job(), false)).toBe('не указан в колонках текущих деталей заказа');
  });
});

describe('order cut issues details key', () => {
  const base = [
    { detail_id: 1, height: 700, width: 596, quantity: 1, sheet_material_type_id: 8 },
    { detail_id: 2, height: 400, width: 300, quantity: 2, sheet_material_type_id: 8 },
  ];
  const key = orderCutIssuesDetailsKey(base);

  it('changes when a detail is deleted, resized, re-quantified or gets another sheet material', () => {
    expect(orderCutIssuesDetailsKey(base.slice(0, 1))).not.toBe(key);
    expect(orderCutIssuesDetailsKey([{ ...base[0], width: 600 }, base[1]])).not.toBe(key);
    expect(orderCutIssuesDetailsKey([base[0], { ...base[1], quantity: 3 }])).not.toBe(key);
    expect(orderCutIssuesDetailsKey([{ ...base[0], sheet_material_type_id: 9 }, base[1]])).not.toBe(key);
  });

  it('is stable for the same details in another order and returns to the old key on restore', () => {
    expect(orderCutIssuesDetailsKey([base[1], base[0]])).toBe(key);
    expect(orderCutIssuesDetailsKey([{ ...base[0] }, { ...base[1] }])).toBe(key);
  });
});

describe('order cut column refs key', () => {
  const cut = new Map([[1, { cutJobId: 1028, resultNo: 2 }], [2, { cutJobId: 1028, resultNo: 2 }]]);
  const bath = new Map([[1, { cutJobId: 2000, resultNo: 1 }]]);
  const key = orderCutColumnRefsKey(cut, bath);

  it('changes when a column cut is recalculated or disappears (e.g. a transfer in another order)', () => {
    expect(orderCutColumnRefsKey(new Map([[1, { cutJobId: 1028, resultNo: 3 }], [2, { cutJobId: 1028, resultNo: 2 }]]), bath)).not.toBe(key);
    expect(orderCutColumnRefsKey(cut, new Map())).not.toBe(key);
    expect(orderCutColumnRefsKey(new Map([[1, { cutJobId: 1028, resultNo: 2 }]]), bath)).not.toBe(key);
  });

  it('does not change for new map objects with the same references, and keeps cut and bath apart', () => {
    expect(orderCutColumnRefsKey(new Map(cut), new Map(bath))).toBe(key);
    expect(orderCutColumnRefsKey(bath, cut)).not.toBe(key);
  });
});

describe('order cut issues refresh lifecycle', () => {
  it('re-reads on any cut-ready event and on the poll, and stops both on cleanup', () => {
    const refresh = vi.fn();
    let listener: (() => void) | null = null;
    const unsubscribe = vi.fn(() => { listener = null; });
    let tick: (() => void) | null = null;
    const timers = {
      setInterval: vi.fn((fn: () => void) => { tick = fn; return 7; }),
      clearInterval: vi.fn(() => { tick = null; }),
    };
    const stop = startOrderCutIssuesRefresh({
      refresh,
      subscribe: (next) => { listener = next; return unsubscribe; },
      intervalMs: 60_000,
      timers,
    });
    expect(timers.setInterval).toHaveBeenCalledWith(refresh, 60_000);

    // an older shared bath recalculated / invalidated elsewhere: no change in this card's details or columns
    listener!();
    tick!();
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(timers.clearInterval).toHaveBeenCalledWith(7);
    expect(listener).toBeNull();
    expect(tick).toBeNull();
  });
});
