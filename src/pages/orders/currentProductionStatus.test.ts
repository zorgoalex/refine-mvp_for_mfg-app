import { describe, expect, it } from 'vitest';
import {
  buildActiveProductionStatusCodeMap,
  resolveActiveProductionEventCodes,
  resolveOrderStageCodes,
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

describe('resolveOrderStageCodes', () => {
  it('returns unique backend order marks and ignores blanks and non-strings', () => {
    expect(resolveOrderStageCodes(['cut', ' cut ', '', null, 42, 'drawn'])).toEqual(['cut', 'drawn']);
    expect(resolveOrderStageCodes(undefined)).toEqual([]);
    expect(resolveOrderStageCodes('cut')).toEqual([]);
  });

  it('prefers loaded event codes, including an explicit empty set', () => {
    expect(resolveOrderStageCodes(['cut'], ['drawn'])).toEqual(['drawn']);
    expect(resolveOrderStageCodes(['cut'], [])).toEqual([]);
  });
});
