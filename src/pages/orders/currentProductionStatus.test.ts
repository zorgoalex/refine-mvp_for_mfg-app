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
});
