import { describe, expect, it } from 'vitest';
import {
  buildActiveProductionStatusCodeMap,
  resolveActiveProductionEventCodes,
  resolveCurrentProductionStatusCodes,
} from './currentProductionStatus';

describe('resolveActiveProductionEventCodes', () => {
  it('returns only unique statuses backed by active order events', () => {
    const statusIdToCode = new Map([[1, 'new'], [2, 'cut']]);

    expect(resolveActiveProductionEventCodes(
      [{ production_status_id: 2 }, { production_status_id: 2 }],
      statusIdToCode,
    )).toEqual(['cut']);
    expect(resolveActiveProductionEventCodes([], statusIdToCode)).toEqual([]);
  });

  it('ignores events whose status is no longer available', () => {
    expect(resolveActiveProductionEventCodes(
      [{ production_status_id: 99 }],
      new Map([[2, 'cut']]),
    )).toEqual([]);
  });

  it('cannot render an inactive catalog status that has no menu item', () => {
    const activeStatusCodes = buildActiveProductionStatusCodeMap([
      { production_status_id: 1, production_status_code: 'new', is_active: false },
      { production_status_id: 2, production_status_code: 'cut', is_active: true },
    ]);

    expect(resolveActiveProductionEventCodes(
      [{ production_status_id: 1 }, { production_status_id: 2 }],
      activeStatusCodes,
    )).toEqual(['cut']);
  });
});

describe('resolveCurrentProductionStatusCodes', () => {
  it('returns exactly the current configured status code', () => {
    expect(resolveCurrentProductionStatusCodes({
      statusId: 7,
      statusName: 'Закатан',
      statusIdToCode: new Map([[7, 'laminated'], [8, 'packed']]),
    })).toEqual(['laminated']);
  });

  it('falls back to the current status name when the id is unavailable', () => {
    expect(resolveCurrentProductionStatusCodes({
      statusName: 'Распилен',
      statusIdToCode: new Map(),
    })).toEqual(['cut']);
  });

  it('does not display historical stages for an unknown current status', () => {
    expect(resolveCurrentProductionStatusCodes({
      statusId: 999,
      statusName: null,
      statusIdToCode: new Map([[7, 'laminated']]),
    })).toEqual([]);
  });

  it('combines events, the order status, and unique detail statuses', () => {
    expect(resolveCurrentProductionStatusCodes({
      statusId: 2,
      statusName: 'Распилен',
      statusIdToCode: new Map([[1, 'drawn'], [2, 'cut']]),
      passedCodes: ['drawn'],
      detailStatuses: [
        { statusId: 2, statusName: 'Распилен' },
        { statusId: 2, statusName: 'Распилен' },
      ],
    })).toEqual(['drawn', 'cut']);
  });

  it('returns a shared detail status only once', () => {
    expect(resolveCurrentProductionStatusCodes({
      statusIdToCode: new Map([[2, 'cut']]),
      detailStatuses: Array.from({ length: 4 }, () => ({ statusId: 2 })),
    })).toEqual(['cut']);
  });
});
