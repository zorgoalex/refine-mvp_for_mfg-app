import { describe, expect, it } from 'vitest';
import { resolveCurrentProductionStatusCodes } from './currentProductionStatus';

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
