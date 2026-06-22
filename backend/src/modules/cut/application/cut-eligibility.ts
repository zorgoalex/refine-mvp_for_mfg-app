/**
 * Eligibility & structured ineligibility (plan §5, Critic MAJOR-4). The
 * eligible-details API never silently drops a candidate: an ineligible detail
 * carries an `ineligible_reason` enum so the /cut page can surface (notably) the
 * `no_sheet_spec` count instead of an unexplained empty list.
 */
export type IneligibleReason =
  | 'deleted'
  | 'wrong_status'
  | 'not_cuttable'
  | 'no_sheet_spec';

export interface DetailEligibilityCandidate {
  detailId: number;
  deleteFlag: boolean;
  productionStatusId: number | null;
  /** Variant B: direct ref on order_details (null = unlinked / no_sheet_spec) */
  sheetMaterialTypeId: number | null;
  /** true when sheet_material_types.is_cuttable = true for this detail's sheet type */
  isCuttable: boolean;
}

export interface CutEligibilityConfig {
  /** configurable SET of ready-to-cut production_status ids */
  readyStatusIds: readonly number[];
}

export interface EligibilityResult {
  eligible: boolean;
  reason: IneligibleReason | null;
}

const ELIGIBLE: EligibilityResult = { eligible: true, reason: null };

function ineligible(reason: IneligibleReason): EligibilityResult {
  return { eligible: false, reason };
}

export function classifyDetailEligibility(
  candidate: DetailEligibilityCandidate,
  config: CutEligibilityConfig,
): EligibilityResult {
  if (candidate.deleteFlag) {
    return ineligible('deleted');
  }
  // NOTE: being already placed in another cut job is NOT an ineligibility — a
  // detail may belong to any number of jobs (placement is informational only,
  // surfaced separately via listDetailPlacements). See migration 031.
  if (
    candidate.productionStatusId === null ||
    !config.readyStatusIds.includes(candidate.productionStatusId)
  ) {
    return ineligible('wrong_status');
  }
  // not_cuttable before no_sheet_spec: a non-cuttable sheet type still has a spec;
  // the isCuttable field is set to true when sheetMaterialTypeId is null (handled
  // below), so this guard only fires when a sheet type is set but is non-cuttable.
  if (!candidate.isCuttable) {
    return ineligible('not_cuttable');
  }
  if (candidate.sheetMaterialTypeId === null) {
    return ineligible('no_sheet_spec');
  }
  return ELIGIBLE;
}
