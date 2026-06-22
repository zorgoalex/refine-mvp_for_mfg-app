import { describe, expect, it } from 'vitest';
import { classifyDetailEligibility } from './cut-eligibility';

const config = { readyStatusIds: [10, 11, 12] };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    detailId: 1,
    deleteFlag: false,
    productionStatusId: 10,
    sheetMaterialTypeId: 99,
    isCuttable: true,
    ...overrides,
  };
}

describe('cut eligibility classification (§5)', () => {
  it('marks a ready, linked detail eligible (no reason)', () => {
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

  it('placement in another job is NOT an ineligibility (multi-job allowed)', () => {
    // A detail already in other jobs stays eligible; placement is informational.
    expect(classifyDetailEligibility(candidate(), config)).toEqual({ eligible: true, reason: null });
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

  it('flags a non-cuttable sheet type (is_cuttable=false) with reason not_cuttable', () => {
    expect(
      classifyDetailEligibility(
        candidate({ sheetMaterialTypeId: 55, isCuttable: false }),
        config,
      ).reason,
    ).toBe('not_cuttable');
  });

  it('not_cuttable detail is ineligible (eligible=false)', () => {
    const result = classifyDetailEligibility(
      candidate({ sheetMaterialTypeId: 55, isCuttable: false }),
      config,
    );
    expect(result.eligible).toBe(false);
  });

  it('a cuttable sheet type (is_cuttable=true) stays eligible', () => {
    expect(
      classifyDetailEligibility(candidate({ isCuttable: true }), config),
    ).toEqual({ eligible: true, reason: null });
  });

  it('null sheetMaterialTypeId (no_sheet_spec) takes precedence over isCuttable default', () => {
    // isCuttable=true default when no sheet type; ensure no_sheet_spec fires, not not_cuttable
    expect(
      classifyDetailEligibility(
        candidate({ sheetMaterialTypeId: null, isCuttable: true }),
        config,
      ).reason,
    ).toBe('no_sheet_spec');
  });
});
