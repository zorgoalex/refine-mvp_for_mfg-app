import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../../types/orders';
import {
  formatOrderRefreshSuccessMessage,
  mergeOrderRefreshDetails,
  noteRequiresDoweling,
} from './orderRefresh';

const detail = (overrides: Partial<OrderDetail>): OrderDetail => ({
  detail_id: 10,
  detail_number: 1,
  height: 100,
  width: 100,
  quantity: 1,
  area: 0.01,
  material_id: null,
  milling_type_id: 1,
  edge_type_id: 1,
  priority: 100,
  ...overrides,
});

describe('order refresh draft merge', () => {
  it('matches only the separate Присадка word', () => {
    expect(noteRequiresDoweling('Нужна ПРИСАДКА.')).toBe(true);
    expect(noteRequiresDoweling('неприсадка')).toBe(false);
    expect(noteRequiresDoweling('присадками')).toBe(false);
  });

  it('preserves dirty editable fields and merges only document relations', () => {
    const current = detail({
      note: 'ручная правка',
      doweling: false,
      height: 777,
      bazis_cut_sets: [{ bazisCutSetId: 1, name: 'old' }],
    });
    const server = detail({
      note: 'Присадка',
      doweling: true,
      height: 100,
      cut_job: { cutJobId: 4, resultNo: 2, cutNumber: '4-2', name: 'Р-4', paramProfileId: null, profileName: null, profileIsActive: null },
      bazis_cut_sets: [{ bazisCutSetId: 9, name: 'БР-9' }],
      bazis_projects: [{ bazisProjectId: 5, bazisRevisionId: 6, revisionNo: 2, name: 'Шкаф' }],
    });

    expect(mergeOrderRefreshDetails([current], [server])).toEqual([
      expect.objectContaining({
        note: 'ручная правка',
        doweling: false,
        height: 777,
        cut_job: server.cut_job,
        bazis_cut_sets: server.bazis_cut_sets,
        bazis_projects: server.bazis_projects,
      }),
    ]);
  });

  it('forces doweling from the current draft note without clearing manual true', () => {
    const server = detail({ doweling: false });
    expect(mergeOrderRefreshDetails([
      detail({ note: 'есть Присадка', doweling: false }),
      detail({ detail_id: 11, note: null, doweling: true }),
    ], [server, detail({ detail_id: 11, doweling: false })]).map((row) => row.doweling)).toEqual([true, true]);
  });

  it('mentions forced auto-status execution in refresh success messages', () => {
    expect(formatOrderRefreshSuccessMessage({
      updatedDowelingDetailIds: [],
      statusAutomation: {
        orderId: 42,
        orderFound: true,
        evaluatedRuleCount: 6,
        matchedRuleCount: 2,
        executedActionCount: 1,
        skippedRuleCount: 4,
        skippedActionCount: 1,
      },
    })).toBe('Заказ и связи с документами обновлены; Автостатусы: проверено правил 6, действий 1');
  });
});
