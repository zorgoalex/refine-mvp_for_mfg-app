import { describe, expect, it } from 'vitest';
import type { OrderLabelCutMapOptions } from '../../../../api/types/labelsApi.types';
import {
  buildDefaultOrderCutMapSelection,
  buildOrderCutMapLabelRows,
  buildOrderCutMapSelections,
  missingOrderCutMapRows,
} from './orderCutMapSelection';

const data: OrderLabelCutMapOptions = {
  orderId: 7,
  details: [{
    detailId: 11,
    detailNumber: '3',
    detailName: 'Фасад',
    quantity: 2,
    options: [
      option(101, 1, 5, '50-4', true),
      option(102, 2, 5, '50-4', true),
      option(201, 1, 4, '40-9', true),
      option(202, 2, 4, '40-9', false),
    ],
  }],
};

describe('order cut-map selection', () => {
  it('creates one exact selector per physical detail instance', () => {
    const rows = buildOrderCutMapLabelRows(data);
    expect(rows.map((row) => [row.key, row.options.map((option) => option.cutNumber)])).toEqual([
      ['11:1', ['50-4', '40-9']],
      ['11:2', ['50-4']],
    ]);
    expect(buildDefaultOrderCutMapSelection(rows)).toEqual({ '11:1': 101, '11:2': 102 });
  });

  it('reports missing choices and emits only the requested preview detail', () => {
    const rows = buildOrderCutMapLabelRows(data);
    const selected = { '11:1': 201 };
    expect(missingOrderCutMapRows(rows, selected).map((row) => row.key)).toEqual(['11:2']);
    expect(buildOrderCutMapSelections(rows, selected, 11)).toEqual([
      { detailId: 11, copyIndex: 1, cutResultPlacementId: 201 },
    ]);
  });

  it('does not mix partial results in the automatic default', () => {
    const rows = buildOrderCutMapLabelRows({
      ...data,
      details: [{
        ...data.details[0],
        options: [
          option(301, 1, 6, '50-5', true),
          option(202, 2, 4, '40-9', true),
        ],
      }],
    });
    expect(buildDefaultOrderCutMapSelection(rows)).toEqual({});
  });
});

function option(
  cutResultPlacementId: number,
  instance: number,
  cutResultId: number,
  cutNumber: string,
  dimensionsMatch: boolean,
) {
  return {
    cutResultPlacementId,
    detailId: 11,
    instance,
    cutResultId,
    cutJobId: 50,
    cutNumber,
    cutJobName: 'Кухня',
    resultNo: 4,
    resultKind: 'auto' as const,
    variant: 'auto' as const,
    sheetIndex: 0,
    sheetNumber: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    isCurrent: true,
    isArchived: false,
    dimensionsMatch,
  };
}
