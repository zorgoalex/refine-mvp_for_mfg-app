import type { DatabaseClient } from '../../../database/database.types';
import type { MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import type { ShadowCommandProof, ShadowProofMember } from '../domain/mdf-shadow-proof';

export class ShadowProofLimitError extends Error {
  constructor(readonly code: string) { super(code); }
}
const MAX_COMMANDS = 1000, MAX_LINES = 10000;
const key = (kind: string, id: string) => `${kind}:${id}`;
type CommandRow = Omit<ShadowCommandProof, 'members'> & { source_kind: string; source_id: string };

/** Two bounded batch reads, on the caller's repeatable-read snapshot. Explicit
 * audit retention expiry is unknown provenance, not permission to invent proof. */
export async function loadMdfShadowProofs(db: DatabaseClient, sources: readonly MdfBoardSource[]) {
  const result = new Map<string, ShadowCommandProof[]>();
  if (!sources.length) return result;
  const commands = (await db.query<CommandRow>(`SELECT c.source_kind,c.source_id,c.observation_id::text sequence,
    c.revision_key revision,c.command_kind kind,c.target_column target,c.composition_digest "compositionDigest",o.issues,
    (r.origin='manual' AND z.revision_key IS NOT NULL AND a.audit_id IS NOT NULL) "provenanceValid"
    FROM unnest($1::text[],$2::text[]) requested(kind,id)
    JOIN mdf_shadow_commands c ON c.source_kind=requested.kind AND c.source_id=requested.id
    LEFT JOIN mdf_evidence_revisions r USING(source_kind,source_id,revision_key)
    LEFT JOIN mdf_revision_seals z USING(source_kind,source_id,revision_key)
    LEFT JOIN mdf_shadow_observations o USING(source_kind,source_id,revision_key)
    LEFT JOIN audit_log a ON a.audit_id=c.audit_event_id AND a.user_id=r.actor_user_id AND a.request_id=r.request_id
      AND a.entity_id=c.source_kind||':'||c.source_id
      AND a.entity_type=CASE WHEN c.command_kind='production_return' THEN 'mdf_board_card' ELSE 'mdf_board_manual_move' END
      AND a.status_code IS NOT DISTINCT FROM c.target_column
      AND ((c.command_kind='manual_move' AND a.event IN ('mdf_board.manual_move.created','mdf_board.manual_move.updated'))
        OR (c.command_kind='manual_clear' AND a.event='mdf_board.manual_move.deleted')
        OR (c.command_kind='production_return' AND a.event='mdf_board.production_returned'
          AND a.status_id=c.target_stage_id AND a.metadata_json->>'previewDigest'=c.preview_digest))
    ORDER BY c.observation_id LIMIT $3`, [sources.map(s => s.kind), sources.map(s => s.id), MAX_COMMANDS + 1])).rows;
  if (commands.length > MAX_COMMANDS) throw new ShadowProofLimitError('COMMAND_LIMIT');
  if (!commands.length) return result;
  const lines = (await db.query<ShadowProofMember & { source_kind: string; source_id: string; revision: string;
    stage: string; evidence: string }>(`SELECT l.source_kind,l.source_id,l.revision_key revision,l.line_key line,
      l.order_id::float8 "orderId",l.detail_id::float8 "detailId",l.quantity::float8 quantity,l.rework,
      l.stage_code stage,l.evidence_kind evidence
    FROM unnest($1::text[],$2::text[],$3::text[]) requested(kind,id,revision)
    JOIN mdf_evidence_lines l ON l.source_kind=requested.kind AND l.source_id=requested.id AND l.revision_key=requested.revision
    ORDER BY l.source_kind,l.source_id,l.revision_key,l.line_key LIMIT $4`,
  [commands.map(c => c.source_kind), commands.map(c => c.source_id), commands.map(c => c.revision), MAX_LINES + 1])).rows;
  if (lines.length > MAX_LINES) throw new ShadowProofLimitError('COMMAND_LINE_LIMIT');
  const byRevision = new Map<string, ShadowCommandProof>();
  for (const c of commands) {
    const proof: ShadowCommandProof = { ...c, provenanceValid: c.provenanceValid === true, members: [] };
    const source = key(c.source_kind, c.source_id);
    const history = result.get(source) ?? []; history.push(proof); result.set(source, history);
    byRevision.set(JSON.stringify([c.source_kind, c.source_id, c.revision]), proof);
  }
  for (const l of lines) {
    const proof = byRevision.get(JSON.stringify([l.source_kind, l.source_id, l.revision]))!;
    if (l.stage !== 'membership' || l.evidence !== 'derived'
      || ![l.orderId,l.detailId,l.quantity].every(n => Number.isSafeInteger(n) && n > 0)) proof.provenanceValid = false;
    proof.members.push({ line: l.line, orderId: l.orderId, detailId: l.detailId, quantity: l.quantity, rework: l.rework });
  }
  return result;
}
