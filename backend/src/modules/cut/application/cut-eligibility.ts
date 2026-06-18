/**
 * Eligibility & structured ineligibility (plan §5, Critic MAJOR-4). The
 * eligible-details API never silently drops a candidate: an ineligible detail
 * carries an `ineligible_reason` enum so the /cut page can surface (notably) the
 * `no_sheet_spec` count instead of an unexplained empty list.
 */
export type IneligibleReason =
  | 'deleted'
  | 'already_reserved'
  | 'wrong_status'
  | 'no_sheet_spec';

export interface DetailEligibilityCandidate {
  detailId: number;
  deleteFlag: boolean;
  productionStatusId: number | null;
  /** resolved via detail -> material -> sheet_material_type (null = unlinked) */
  sheetMaterialTypeId: number | null;
  /** true when the detail is already in another ACTIVE cut_job_item */
  alreadyReserved: boolean;
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
  if (candidate.alreadyReserved) {
    return ineligible('already_reserved');
  }
  if (
    candidate.productionStatusId === null ||
    !config.readyStatusIds.includes(candidate.productionStatusId)
  ) {
    return ineligible('wrong_status');
  }
  if (candidate.sheetMaterialTypeId === null) {
    return ineligible('no_sheet_spec');
  }
  return ELIGIBLE;
}
