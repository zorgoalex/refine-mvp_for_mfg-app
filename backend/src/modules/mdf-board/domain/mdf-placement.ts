import { z } from 'zod';
import { isMdfSourceColumnAllowed, resolveMdfSourceColumn } from './mdf-source-column';

/** Rank-independent placement inputs of a published card (§5.4d). Everything here changes only through
 * receipts/jobs; the members' production ranks are read live, so placement never goes stale after a
 * detail status change. `publishedRevision` binds the inputs to the publication row that wrote them. */
export interface MdfPlacementInputs {
  schemaVersion: 1;
  publishedRevision: string;
  kind: 'packet' | 'bazisCutSet' | 'bath';
  verified: boolean;
  intentionalEmpty: boolean;
  manual: string | null;
  fullCut: boolean;
  fullRolled: boolean;
  balanceBlocked: boolean;
  bathReadiness: 'ready' | 'not_ready' | 'unknown';
  priorColumn: string | null;
}
export interface MdfPlacementThresholds { packed: number | null; issued: number | null; laminated: number | null }
export interface MdfPlacement { column: string | null; reason: string; issues: string[] }

const COLUMNS = ['parsed', 'completed', 'completed_laminated', 'baths', 'baths_ready', 'baths_laminated', 'completed_baths'] as const;
const column = z.enum(COLUMNS).nullable();
/** Mirror of SQL `mdf_placement_inputs_valid` (migration 189); parity is tested case by case. */
const inputsSchema = z.object({
  schemaVersion: z.literal(1),
  publishedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  kind: z.enum(['packet', 'bazisCutSet', 'bath']),
  verified: z.boolean(),
  intentionalEmpty: z.boolean(),
  manual: column,
  fullCut: z.boolean(),
  fullRolled: z.boolean(),
  balanceBlocked: z.boolean(),
  bathReadiness: z.enum(['ready', 'not_ready', 'unknown']),
  priorColumn: column,
}).strict();

/** Inputs usable only when valid AND bound to the row's current published revision. */
export function parseMdfPlacementInputs(raw: unknown, publishedRevision: string): MdfPlacementInputs | null {
  const parsed = inputsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.publishedRevision !== publishedRevision) return null;
  return parsed.data as MdfPlacementInputs;
}

/** The single placement rule for the job projection, the board reader and command validation. */
export function mdfPlacement(inputs: Omit<MdfPlacementInputs, 'schemaVersion' | 'publishedRevision'>,
  memberRanks: readonly (number | null)[], thresholds: MdfPlacementThresholds): MdfPlacement {
  const issues: string[] = [];
  // A genuine intentional-empty BASIS has no members; the generic resolver would block it with
  // INCOMPLETE_COMPOSITION. Bypass only that exact case.
  const resolved = inputs.verified && !inputs.intentionalEmpty ? resolveMdfSourceColumn({ kind: inputs.kind,
    memberRanks, compositionComplete: true, cutConfirmed: inputs.fullCut, manual: inputs.manual, thresholds,
    bathReadiness: inputs.bathReadiness }) : null;
  issues.push(...(resolved?.issues ?? []));
  // An authenticated empty card: an explicit kind-valid manual placement (a correction's target column)
  // is honored, an out-of-contract manual string is flagged and ignored.
  const emptyManualAllowed = inputs.manual !== null && isMdfSourceColumnAllowed(inputs.kind, inputs.manual);
  if (inputs.intentionalEmpty && inputs.manual !== null && !emptyManualAllowed) issues.push('INVALID_MANUAL_COLUMN');
  // Every physical bath confirmation is explicit, unlike a mutable prior visual override.
  const placed = inputs.intentionalEmpty
    ? (emptyManualAllowed ? inputs.manual : inputs.priorColumn)
    : inputs.verified && inputs.kind === 'bath' && inputs.fullRolled && !inputs.balanceBlocked
      && resolved?.column !== 'completed_baths' ? 'baths_laminated' : resolved?.column ?? inputs.priorColumn;
  return { column: placed, issues,
    reason: inputs.intentionalEmpty ? 'assignment_empty' : resolved?.reason ?? 'requires_verification' };
}
