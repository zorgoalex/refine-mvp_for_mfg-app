import type { DatabaseClient } from '../../../database/database.types';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { MdfNeedsAttention, type MdfSourceKind } from '../application/mdf-job-runner';
import { mdfDemandDigest, type MdfExecutionContext } from '../domain/mdf-execution-context';
import type { MdfPositionQuantity } from '../domain/mdf-quantities';
import { mdfLineageRevisionKey } from '../domain/mdf-physical-lineage';
import { loadMdfPhysicalLineageSnapshot } from './mdf-physical-lineage-snapshot';
import { loadMdfBazisAssignmentStateSnapshot } from './mdf-bazis-assignment-state-snapshot';

export interface MdfExecutionHead {
  kind: MdfSourceKind; id: string; received: string; accepted: string | null; epoch: string;
}
export interface MdfExecutionDetail extends MdfPositionQuantity { rank: number | null }
export interface MdfExecutionMetadata {
  kind: MdfSourceKind; id: string; revision: string; sourceCreatedAt: string; displayName: string;
  priorColumn: string | null; compositionComplete: boolean; demandDigest: string;
  manualPlacementColumn: string | null;
  effectPolicy: 'forward' | 'publish_only';
}
export const mdfSourceKey = (source: { kind: string; id: string }) => JSON.stringify([source.kind,source.id]);

/** Same canonical demand loader for command preflight and queued execution.
 * Caller holds complete sorted owning orders. Dimensions/names/status changes
 * do not alter the digest; MDF membership, quantity and identity do. */
export async function loadMdfExecutionDetails(tx: DatabaseClient, orderIds: readonly number[]): Promise<MdfExecutionDetail[]> {
  const rows = (await tx.query<MdfExecutionDetail>(`SELECT d.order_id::float8 "orderId",d.detail_id::float8 "detailId",
    d.quantity::float8 quantity,s.sort_order rank
    FROM order_details d JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag AND o.order_kind='production_order'
    LEFT JOIN production_statuses s ON s.production_status_id=d.production_status_id
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE d.order_id=ANY($1::bigint[]) AND NOT d.delete_flag
      AND COALESCE(mt.name,m.material_name,'') ~* $2 AND COALESCE(mt.name,m.material_name,'') !~* $3
    ORDER BY d.order_id,d.detail_id LIMIT 5001`, [orderIds,MDF,OTHER])).rows;
  if (rows.length > 5000) throw new MdfNeedsAttention('MDF_DEMAND_LIMIT');
  for (const d of rows) if (![d.orderId,d.detailId].every(n => Number.isSafeInteger(n) && n>0)
    || !Number.isSafeInteger(d.quantity) || d.quantity<0) throw new MdfNeedsAttention('MDF_INVALID_DEMAND');
  return rows;
}

/** Batch-only loader: no source JSON, no per-card query. Missing frozen context
 * is LOCAL unverified data, never authorization to use a shadow snapshot. */
export async function loadMdfExecutionSnapshot(tx: DatabaseClient, heads: readonly MdfExecutionHead[], orderIds: readonly number[],
  options:{allowPendingJobId?:string}={}) {
  // The compact card describes RECEIVED membership, including a pending change.
  // Credit still requires accepted==received; never label old context as rev2.
  const args = [heads.map(h => h.kind),heads.map(h => h.id),heads.map(h => h.received)];
  const contexts = (await tx.query<MdfExecutionMetadata>(`SELECT c.source_kind kind,c.source_id id,c.revision_key revision,
    c.source_created_at::text "sourceCreatedAt",c.display_name "displayName",c.prior_column "priorColumn",
    c.composition_complete "compositionComplete",c.demand_digest "demandDigest",c.manual_placement_column "manualPlacementColumn",
    c.effect_policy "effectPolicy"
    FROM unnest($1::text[],$2::text[],$3::text[]) h(kind,id,revision)
    JOIN mdf_revision_context c ON c.source_kind=h.kind AND c.source_id=h.id AND c.revision_key=h.revision
    JOIN mdf_revision_seals z USING(source_kind,source_id,revision_key)`,args)).rows;
  const demand = (await tx.query<MdfPositionQuantity & { kind: MdfSourceKind; id: string }>(`SELECT d.source_kind kind,d.source_id id,
    d.order_id::float8 "orderId",d.detail_id::float8 "detailId",d.quantity::float8 quantity
    FROM unnest($1::text[],$2::text[],$3::text[]) h(kind,id,revision)
    JOIN mdf_revision_demand d ON d.source_kind=h.kind AND d.source_id=h.id AND d.revision_key=h.revision
    ORDER BY d.source_kind,d.source_id,d.order_id,d.detail_id LIMIT 50001`,args)).rows;
  if (demand.length>50000) throw new MdfNeedsAttention('MDF_CONTEXT_LIMIT');
  const details = await loadMdfExecutionDetails(tx,orderIds);
  const assignmentState = await loadMdfBazisAssignmentStateSnapshot(tx,heads,options);
  const physicalLineage = await loadMdfPhysicalLineageSnapshot(tx,heads,{assignmentStates:assignmentState.states});
  const metadata = new Map(contexts.map(c => [mdfSourceKey(c),c]));
  const issues = new Map<string,string[]>(), frozenDemand = new Map<string,MdfExecutionContext['demand']>();
  // §5.4b: a bath whose RECEIVED revision is an authenticated retirement (transition row, empty sealed
  // revision) is terminal: no demand/context issues; excluded from projection and allocation by callers.
  const retiredRows = (await tx.query<{ id: string; revision: string }>(`SELECT t.retired_source_id id,t.retired_revision_key revision
    FROM mdf_bath_transitions t JOIN unnest($1::text[],$2::text[],$3::text[]) h(kind,id,revision)
      ON h.kind='bath' AND t.retired_source_id=h.id AND t.retired_revision_key=h.revision`,args)).rows;
  const retired = new Set(retiredRows.map(r => mdfSourceKey({ kind: 'bath', id: r.id })));
  for (const h of heads) {
    const key = mdfSourceKey(h), c = metadata.get(key), rows = demand.filter(d => mdfSourceKey(d)===key);
    frozenDemand.set(key,rows);
    if (retired.has(key)) { issues.set(key,[]); continue; }
    const owners = new Set(rows.map(d => d.orderId));
    const own: string[] = [];
    if (!c) own.push('MDF_CONTEXT_REQUIRED');
    else if (c.effectPolicy !== 'forward' && c.effectPolicy !== 'publish_only') own.push('MDF_CONTEXT_INVALID');
    else if (!c.compositionComplete) own.push('MDF_COMPOSITION_UNRESOLVED');
    else if (!rows.length) own.push('MDF_CONTEXT_REQUIRED');
    else if (mdfDemandDigest(rows)!==c.demandDigest) own.push('MDF_CONTEXT_INVALID');
    else if ([...owners].some(id => !orderIds.includes(id))
      || mdfDemandDigest(details.filter(d => owners.has(d.orderId)))!==c.demandDigest) own.push('MDF_DEMAND_CHANGED');
    // Only the currently visible RECEIVED revision controls source-local
    // lineage quarantine. An old accepted revision cannot bless a malformed
    // pending revision, and a malformed v2 seal is never silently treated as
    // legacy v1 evidence.
    const lineageIssue = physicalLineage.lineageIssues.get(mdfLineageRevisionKey(h,h.received));
    if (lineageIssue) own.push(...lineageIssue);
    const assignmentIssue = assignmentState.issues.get(mdfSourceKey(h));
    if (assignmentIssue) own.push(...assignmentIssue);
    issues.set(key,own);
  }
  return { details, metadata, issues, frozenDemand, retired,
    lineage: physicalLineage.lineage, lineageIssues: physicalLineage.lineageIssues,
    assignmentStates:assignmentState.states,assignmentStateIssues:assignmentState.issues };
}
