import { describe, expect, it } from 'vitest';
import type { OrderLabelCutMapOptions } from '../../../../api/types/labelsApi.types';
import {
  buildDefaultOrderCutMapSelection,
  buildOrderCutMapLabelRows,
  buildOrderCutMapSelectionForSource,
  buildOrderCutMapSelections,
  filterOrderCutMapRowOptions,
  filterOrderCutMapRowsForSource,
  missingOrderCutMapRows,
  orderCutMapRawOptionMatchesSource,
  orderCutMapSourceCutNumbers,
  pickDefaultOrderCutMapSource,
} from './orderCutMapSelection';

const data: OrderLabelCutMapOptions = {
  orderId: 7,
  details: [{
    detailId: 11,
    detailNumber: '3',
    detailName: 'Фасад',
    quantity: 2,
    cutJobCutNumber: '50-4',
    bathCutJobCutNumber: null,
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

  it('filters archived cut result placements out of label choices', () => {
    const rows = buildOrderCutMapLabelRows({
      ...data,
      details: [{
        ...data.details[0],
        quantity: 1,
        options: [
          { ...option(401, 1, 8, '50-8', true), isArchived: true },
          option(402, 1, 9, '50-9', true),
        ],
      }],
    });

    expect(rows[0]?.options.map((item) => item.cutNumber)).toEqual(['50-9']);
    expect(buildDefaultOrderCutMapSelection(rows)).toEqual({ '11:1': 402 });
  });

  it('prefers the current non-vacuum cut result over vacuum and stale candidates', () => {
    const rows = buildOrderCutMapLabelRows({
      ...data,
      details: [{
        ...data.details[0],
        options: [
          { ...option(501, 1, 20, '28-2', true), isCurrent: true, isVacuum: true },
          { ...option(502, 2, 20, '28-2', true), isCurrent: true, isVacuum: true },
          { ...option(601, 1, 21, '45-1', true), isCurrent: true, isVacuum: false },
          { ...option(602, 2, 21, '45-1', true), isCurrent: true, isVacuum: false },
          { ...option(701, 1, 22, '40-9', true), isCurrent: false, isVacuum: false },
          { ...option(702, 2, 22, '40-9', true), isCurrent: false, isVacuum: false },
        ],
      }],
    });

    expect(buildDefaultOrderCutMapSelection(rows)).toEqual({ '11:1': 601, '11:2': 602 });
  });

  it('builds a regular-source selection from the detail cut field only', () => {
    const rows = buildOrderCutMapLabelRows({
      ...data,
      details: [{
        ...data.details[0],
        quantity: 5,
        cutJobCutNumber: '45-1',
        bathCutJobCutNumber: '28-2',
        options: [
          option(601, 1, 21, '45-1', true),
          option(602, 2, 21, '45-1', true),
          option(603, 3, 21, '45-1', true),
          option(604, 4, 21, '45-1', true),
          { ...option(501, 1, 20, '28-2', true), isVacuum: true },
          { ...option(502, 2, 20, '28-2', true), isVacuum: true },
          { ...option(503, 3, 20, '28-2', true), isVacuum: true },
          { ...option(504, 4, 20, '28-2', true), isVacuum: true },
          { ...option(505, 5, 20, '28-2', true), isVacuum: true },
        ],
      }],
    });

    expect(pickDefaultOrderCutMapSource(rows)).toBe('regular');
    expect(orderCutMapSourceCutNumbers(rows, 'regular')).toEqual(['45-1']);
    expect(orderCutMapSourceCutNumbers(rows, 'bath')).toEqual(['28-2']);
    expect(buildOrderCutMapSelectionForSource(rows, 'regular')).toEqual({
      '11:1': 601,
      '11:2': 602,
      '11:3': 603,
      '11:4': 604,
    });
    expect(filterOrderCutMapRowOptions(rows[4], 'regular')).toEqual([]);
    const regularRows = rows
      .map((row) => ({ ...row, options: filterOrderCutMapRowOptions(row, 'regular') }))
      .filter((row) => row.options.length > 0);
    expect(missingOrderCutMapRows(regularRows, buildOrderCutMapSelectionForSource(rows, 'regular'))).toEqual([]);
  });

  it('builds a bath-source selection from the detail bath calculation field', () => {
    const rows = buildOrderCutMapLabelRows({
      ...data,
      details: [{
        ...data.details[0],
        cutJobCutNumber: '45-1',
        bathCutJobCutNumber: '28-2',
        options: [
          option(601, 1, 21, '45-1', true),
          option(602, 2, 21, '45-1', true),
          { ...option(501, 1, 20, '28-2', true), isVacuum: true },
          { ...option(502, 2, 20, '28-2', true), isVacuum: true },
        ],
      }],
    });

    expect(buildOrderCutMapSelectionForSource(rows, 'bath')).toEqual({ '11:1': 501, '11:2': 502 });
    expect(filterOrderCutMapRowOptions(rows[0], 'bath').map((item) => item.cutNumber)).toEqual(['28-2']);
  });

  it('matches stale raw options against the selected source cut number', () => {
    const detail = {
      ...data.details[0],
      cutJobCutNumber: '45-1',
      bathCutJobCutNumber: '28-2',
    };

    expect(orderCutMapRawOptionMatchesSource(detail, option(601, 1, 21, '45-1', false), 'regular')).toBe(true);
    expect(orderCutMapRawOptionMatchesSource(detail, { ...option(501, 1, 20, '28-2', false), isVacuum: true }, 'bath')).toBe(true);
    expect(orderCutMapRawOptionMatchesSource(detail, { ...option(501, 1, 20, '28-2', false), isVacuum: true }, 'regular')).toBe(false);
  });

  it('treats Telegram SVG and screenshot fallbacks as regular-source coverage', () => {
    const rows = buildOrderCutMapLabelRows({
      orderId: 7,
      details: [{
        ...data.details[0],
        quantity: 2,
        cutJobCutNumber: null,
        options: [],
        telegramSvgFallbackInstances: [{ copyIndex: 1, packetId: 'p1', sourceMessageId: 10 }],
        telegramImageFallbackInstances: [{ copyIndex: 2, packetId: 'p2', sourceMessageId: 11 }],
        telegramImageUnavailableInstances: [],
      }],
    });

    expect(rows.map((row) => row.telegramFallback)).toEqual(['svg', 'image']);
    expect(pickDefaultOrderCutMapSource(rows)).toBe('regular');
    expect(orderCutMapSourceCutNumbers(rows, 'regular')).toEqual(['Telegram']);
    expect(missingOrderCutMapRows(rows, {})).toEqual([]);
    expect(buildOrderCutMapSelections(rows, {})).toEqual([]);
  });

  it('does not let Telegram fallback bypass an available cut-result selection', () => {
    const rows = buildOrderCutMapLabelRows({
      orderId: 7,
      details: [{
        ...data.details[0],
        quantity: 1,
        options: [option(101, 1, 5, '50-4', true)],
        telegramSvgFallbackInstances: [{ copyIndex: 1, packetId: 'p1', sourceMessageId: 10 }],
      }],
    });

    expect(missingOrderCutMapRows(rows, {}).map((row) => row.key)).toEqual(['11:1']);
    expect(missingOrderCutMapRows(rows, { '11:1': 101 })).toEqual([]);
  });

  it('keeps Telegram image unavailability reason for truthful UI state', () => {
    const rows = buildOrderCutMapLabelRows({
      orderId: 7,
      details: [{
        ...data.details[0],
        quantity: 1,
        options: [],
        telegramImageUnavailableInstances: [{ copyIndex: 1, reason: 'invalid_media' }],
      }],
    });

    expect(rows[0]?.telegramFallback).toBeNull();
    expect(rows[0]?.telegramUnavailableReason).toBe('invalid_media');
    expect(filterOrderCutMapRowsForSource(rows, 'bath')[0]).toMatchObject({
      telegramFallback: null,
      telegramUnavailableReason: null,
    });
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
    isVacuum: false,
    dimensionsMatch,
  };
}
