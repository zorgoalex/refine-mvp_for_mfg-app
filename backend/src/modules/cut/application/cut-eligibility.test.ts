import { describe, expect, it } from 'vitest';
import { classifyDetailEligibility } from './cut-eligibility';

const config = { readyStatusIds: [10, 11, 12] };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    detailId: 1,
    deleteFlag: false,
    productionStatusId: 10,
    sheetMaterialTypeId: 99,
    alreadyReserved: false,
    ...overrides,
  };
}

describe('cut eligibility classification (§5)', () => {
  it('marks a ready, linked, unreserved detail eligible (no reason)', () => {
    expect(classifyDetailEligibility(candidate(), config)).toEqual({
      eligible: true,
      reason: null,
    });
  });

  it('flags deleted details', () => {
    expect(classifyDetailEligibility(candidate({ deleteFlag: true }), config).reason).toBe(
      'deleted',
    );
  });

  it('flags already-reserved details', () => {
    expect(
      classifyDetailEligibility(candidate({ alreadyReserved: true }), config).reason,
    ).toBe('already_reserved');
  });

  it('flags a status not in the configured ready set', () => {
    expect(
      classifyDetailEligibility(candidate({ productionStatusId: 20 }), config).reason,
    ).toBe('wrong_status');
  });

  it('flags missing sheet spec (the dominant Day-0 state)', () => {
    expect(
      classifyDetailEligibility(candidate({ sheetMaterialTypeId: null }), config).reason,
    ).toBe('no_sheet_spec');
  });

  it('never silently drops a candidate: ineligible always carries a reason', () => {
    const result = classifyDetailEligibility(
      candidate({ deleteFlag: true, sheetMaterialTypeId: null }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).not.toBeNull();
  });
});
