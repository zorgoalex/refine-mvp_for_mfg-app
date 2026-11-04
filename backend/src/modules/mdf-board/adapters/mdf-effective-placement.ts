import type { DatabaseClient } from '../../../database/database.types';
import { mdfPlacement, parseMdfPlacementInputs, type MdfPlacementThresholds } from '../domain/mdf-placement';
import { mdfSourceKey } from './mdf-execution-snapshot';

/** Stage thresholds used by every MDF placement (same predicates as the accepted job). */
export const MDF_PLACEMENT_THRESHOLDS_SQL = `SELECT
  MIN(sort_order) FILTER(WHERE production_status_code='packed' OR lower(trim(production_status_name))='упакован') packed,
  MIN(sort_order) FILTER(WHERE production_status_code='issued' OR lower(trim(production_status_name))='выдан') issued,
  MIN(sort_order) FILTER(WHERE production_status_code='laminated' OR lower(trim(production_status_name))='закатан') laminated
  FROM production_statuses`;

export interface MdfEffectivePlacement {
  column: string | null; reason: string; storedColumn: string | null; publishedRevision: string;
  /** false ⇒ inputs missing/invalid/stale: stored column shown, card not movable. */
  valid: boolean;
  /** Live placement issues (e.g. STAGE_THRESHOLDS_MISSING); non-empty ⇒ the card is not movable. */
  issues: string[];
  /** Live member ranks in member order (bound into command preview digests). */
  memberRanks: (number | null)[];
}

/**
 * §5.4d read-time placement: published rank-independent inputs + the members' live production ranks.
 * Read-only; never writes, never runs automation. Commands pass `lock: true` AFTER their owner/source
 * locks: member detail rows (ascending) and the production status catalogue are locked FOR SHARE and kept
 * to commit, so a concurrent status writer cannot change a decision input between read and write.
 */
export async function loadMdfEffectivePlacement(tx: DatabaseClient, sources: readonly { kind: string; id: string }[],
  options: { lock?: boolean } = {}): Promise<Map<string, MdfEffectivePlacement>> {
  const result = new Map<string, MdfEffectivePlacement>();
  if (!sources.length) return result;
  const args = [sources.map(s => s.kind), sources.map(s => s.id)];
  if (options.lock) {
    await tx.query(`SELECT d.detail_id FROM order_details d
      WHERE d.detail_id IN (SELECT m.detail_id FROM mdf_published_source_members m
        JOIN unnest($1::text[],$2::text[]) s(kind,id) ON m.source_kind=s.kind AND m.source_id=s.id)
      ORDER BY d.detail_id FOR SHARE`, args);
    await tx.query('SELECT production_status_id FROM production_statuses ORDER BY production_status_id FOR SHARE');
  }
  const rows = (await tx.query<{ kind: string; id: string; column: string | null; reason: string; revision: string;
    inputs: unknown; valid: boolean }>(`SELECT p.source_kind kind,p.source_id id,p.column_key "column",p.reason,
      p.published_revision::text revision,p.placement_inputs inputs,
      mdf_placement_inputs_valid(p.placement_inputs,p.published_revision) valid
    FROM mdf_published_sources p JOIN unnest($1::text[],$2::text[]) s(kind,id) ON p.source_kind=s.kind AND p.source_id=s.id`,
  args)).rows;
  // Same member set and rank source as the projection (non-deleted details; missing ⇒ null rank).
  const ranks = (await tx.query<{ kind: string; id: string; rank: number | null }>(`SELECT m.source_kind kind,m.source_id id,
      st.sort_order rank
    FROM mdf_published_source_members m JOIN unnest($1::text[],$2::text[]) s(kind,id) ON m.source_kind=s.kind AND m.source_id=s.id
    LEFT JOIN order_details d ON d.detail_id=m.detail_id AND d.order_id=m.order_id AND NOT d.delete_flag
    LEFT JOIN production_statuses st ON st.production_status_id=d.production_status_id
    ORDER BY m.source_kind,m.source_id,m.order_id,m.detail_id`, args)).rows;
  const thresholds = (await tx.query<MdfPlacementThresholds>(MDF_PLACEMENT_THRESHOLDS_SQL)).rows[0];
  for (const row of rows) {
    const key = mdfSourceKey(row);
    const memberRanks = ranks.filter(r => r.kind === row.kind && r.id === row.id).map(r => r.rank === null ? null : Number(r.rank));
    // SQL rule and the strict parser must both accept; either rejection ⇒ inputs unusable.
    const inputs = row.valid ? parseMdfPlacementInputs(row.inputs, row.revision) : null;
    if (!inputs) {
      result.set(key, { column: row.column, reason: row.reason, storedColumn: row.column, publishedRevision: row.revision,
        valid: false, issues: ['MDF_PLACEMENT_INPUTS_MISSING'], memberRanks });
      continue;
    }
    const placement = mdfPlacement(inputs, memberRanks, thresholds);
    result.set(key, { column: placement.column, reason: placement.reason, storedColumn: row.column,
      publishedRevision: row.revision, valid: true, issues: placement.issues, memberRanks });
  }
  return result;
}
