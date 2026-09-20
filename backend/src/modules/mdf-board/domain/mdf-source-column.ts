export type MdfSourceKind = 'packet' | 'bazisCutSet' | 'bath';
export type MdfSourceColumn = 'parsed' | 'completed' | 'completed_laminated'
  | 'baths' | 'baths_ready' | 'baths_laminated' | 'completed_baths';
export interface MdfSourceColumnInput {
  kind: MdfSourceKind;
  /** Complete, material-filtered OWN composition. Never all details of owners. */
  memberRanks: readonly (number | null)[];
  compositionComplete: boolean;
  cutConfirmed: boolean;
  manual: string | null;
  /** Supplied by the allocation planner, not inferred from a visual column. */
  bathReadiness: 'ready' | 'not_ready' | 'unknown';
  thresholds: { packed: number | null; issued: number | null; laminated: number | null };
}
export interface MdfSourceColumnResult {
  column: MdfSourceColumn | null;
  reason: 'blocked' | 'all_issued' | 'cut_and_all_packed' | 'all_packed' | 'all_laminated'
    | 'allocated_cut' | 'awaiting_cut' | 'cut_confirmed' | 'manual';
  issues: string[];
}
const columns: Record<MdfSourceKind, readonly MdfSourceColumn[]> = {
  packet: ['parsed', 'completed', 'completed_laminated'],
  bazisCutSet: ['parsed', 'completed', 'completed_laminated'],
  bath: ['baths', 'baths_ready', 'baths_laminated', 'completed_baths'],
};

/** Placement only: cannot manufacture quantities, accept evidence, allocate
 * supply or run rules. Shadow is the first consumer; legacy readers still own
 * production placement until the separate connection/cutover gates pass. */
export function resolveMdfSourceColumn(input: MdfSourceColumnInput): MdfSourceColumnResult {
  const blocked = (issue: string): MdfSourceColumnResult => ({ column: null, reason: 'blocked', issues: [issue] });
  if (!input.compositionComplete || !input.memberRanks.length) return blocked('INCOMPLETE_COMPOSITION');
  const manual = input.manual === null ? null : columns[input.kind].find(c => c === input.manual);
  if (manual === undefined) return blocked('INVALID_MANUAL_COLUMN');
  const { packed, issued, laminated } = input.thresholds;
  const required = input.kind === 'bath' ? [packed, laminated] : [packed, issued];
  if (required.some(rank => rank === null || !Number.isFinite(rank))) return blocked('STAGE_THRESHOLDS_MISSING');
  const allAt = (rank: number | null) => rank !== null && input.memberRanks.every(r => r !== null && Number.isFinite(r) && r >= rank);
  let result: MdfSourceColumnResult;
  if (input.kind === 'bath') {
    if (allAt(packed)) result = { column: 'completed_baths', reason: 'all_packed', issues: [] };
    else if (allAt(laminated)) result = { column: 'baths_laminated', reason: 'all_laminated', issues: [] };
    else if (input.bathReadiness === 'unknown') result = blocked('ALLOCATION_BASELINE_UNKNOWN');
    else result = input.bathReadiness === 'ready'
      ? { column: 'baths_ready', reason: 'allocated_cut', issues: [] }
      : { column: 'baths', reason: 'awaiting_cut', issues: [] };
  } else {
    const cut = input.cutConfirmed || manual === 'completed' || manual === 'completed_laminated';
    if (allAt(issued)) result = { column: 'completed_laminated', reason: 'all_issued', issues: [] };
    else if (allAt(packed) && (cut || input.kind === 'bazisCutSet')) result = {
      column: 'completed_laminated', reason: cut ? 'cut_and_all_packed' : 'all_packed', issues: [],
    };
    else result = cut ? { column: 'completed', reason: 'cut_confirmed', issues: [] }
      : { column: 'parsed', reason: 'awaiting_cut', issues: [] };
  }
  // A plain visual override cannot undo terminal facts. A real production
  // correction must change the underlying status/evidence in its own command.
  if (manual && result.column !== 'completed_baths' && result.column !== 'completed_laminated') {
    result = { ...result, column: manual, reason: 'manual' };
  }
  return result;
}
