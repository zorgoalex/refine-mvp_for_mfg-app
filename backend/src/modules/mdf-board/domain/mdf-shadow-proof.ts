import type { MdfPositionQuantity } from './mdf-quantities';

export interface ShadowProofMember extends MdfPositionQuantity { line: string; rework: boolean }
export interface ShadowCommandProof {
  sequence: string; revision: string; kind: 'manual_move' | 'manual_clear' | 'production_return';
  target: string | null; compositionDigest: string;
  provenanceValid: boolean; issues: string[] | null; members: ShadowProofMember[];
}
interface ProofInput {
  kind: 'packet' | 'bazisCutSet' | 'bath'; compositionDigest?: string;
  members: readonly (MdfPositionQuantity & { line: string })[];
  rework: boolean; rawCut: boolean; issues: readonly string[]; commands: readonly ShadowCommandProof[];
}
const expectedIssues = new Set(['SHADOW_ONLY', 'INCOMPLETE_PRODUCER_COVERAGE', 'EXPLICIT_COMMAND_UNVERIFIED']);
const membersKey = (members: readonly ShadowProofMember[]) => JSON.stringify(members.map(m =>
  JSON.stringify([m.line, m.orderId, m.detailId, m.quantity, m.rework])).sort());

/** Observed diagnostic proof only, NOT receipt acceptance. One source portion
 * per stage: repeated confirmation and raw CNC never become additive shipments.
 * Return stage bands were validated by the owning preview/confirm command;
 * historical custom stages must not be reinterpreted via a mutable catalogue. */
export function projectMdfShadowProof(input: ProofInput) {
  const issues = new Set(input.issues);
  const seen = new Set<string>();
  const current = membersKey(input.members.map(m => ({ ...m, rework: input.rework })));
  for (const c of input.commands) {
    if (!/^[1-9]\d*$/.test(c.sequence) || seen.has(c.sequence)) issues.add('COMMAND_SEQUENCE_INVALID');
    seen.add(c.sequence);
    if (!c.provenanceValid || !c.issues) issues.add('COMMAND_PROVENANCE_INVALID');
    for (const issue of c.issues ?? []) if (!expectedIssues.has(issue)) issues.add(issue);
    if (!input.compositionDigest || c.compositionDigest !== input.compositionDigest) issues.add('COMMAND_COMPOSITION_CHANGED');
    if (!c.members.length || membersKey(c.members) !== current) issues.add('COMMAND_MEMBERSHIP_MISMATCH');
  }
  let cutRevision: string | null = null, laminatedRevision: string | null = null;
  if (!issues.size) for (const c of [...input.commands].sort((a,b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)) {
    if (c.kind === 'manual_move') {
      if (input.kind !== 'bath' && c.target === 'completed') cutRevision = c.revision;
      if (input.kind === 'bath' && c.target === 'baths_laminated') laminatedRevision = c.revision;
    } else if (c.kind === 'production_return') {
      if (input.kind !== 'bath' && c.target === 'parsed') cutRevision = null;
      if (input.kind === 'bath' && (c.target === 'baths' || c.target === 'baths_ready')) laminatedRevision = null;
    }
    // manual_clear, terminal/archive placement and other visual moves neither
    // manufacture nor revoke physical work. Only explicit return revokes it.
  }
  return { cut: !issues.size && (cutRevision !== null || (input.kind === 'packet' && input.rawCut)),
    laminated: !issues.size && laminatedRevision !== null,
    cutRevision, laminatedRevision, commandCount: input.commands.length, issues: [...issues].sort() };
}
