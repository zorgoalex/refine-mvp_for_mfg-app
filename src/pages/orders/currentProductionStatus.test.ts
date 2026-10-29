import { describe, expect, it } from 'vitest';
import {
  buildStageMarksSignature,
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

  it('takes letters only from the backend projection (saw is a normal code)', () => {
    expect(resolveOrderStageCodes(['saw', 'drawn'])).toEqual(['saw', 'drawn']);
    // Extra arguments (legacy event codes) are ignored.
    expect((resolveOrderStageCodes as (...args: unknown[]) => string[])(['cut'], ['drawn'])).toEqual(['cut']);
    expect((resolveOrderStageCodes as (...args: unknown[]) => string[])(undefined, ['drawn'])).toEqual([]);
  });
});

describe('buildStageMarksSignature', () => {
  const details = [{ detail_id: 1, production_status_id: 16 }, { detail_id: 2, production_status_id: 6 }];
  const hdf = [{ order_hdf_detail_id: 7, production_status_id: 16 }];

  it('changes when an ordinary detail changes stage', () => {
    expect(buildStageMarksSignature(details, hdf))
      .not.toBe(buildStageMarksSignature([details[0], { detail_id: 2, production_status_id: 7 }], hdf));
  });

  it('changes when only an HDF detail changes stage', () => {
    expect(buildStageMarksSignature(details, hdf))
      .not.toBe(buildStageMarksSignature(details, [{ order_hdf_detail_id: 7, production_status_id: 19 }]));
  });

  it('is stable for the same stages', () => {
    expect(buildStageMarksSignature(details.map((d) => ({ ...d })), hdf.map((d) => ({ ...d }))))
      .toBe(buildStageMarksSignature(details, hdf));
  });
});
