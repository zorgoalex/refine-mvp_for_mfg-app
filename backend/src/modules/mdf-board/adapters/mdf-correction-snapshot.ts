import { ApiError } from '../../../common/errors/api-error';
import type { QueryResultRow } from 'pg';
import { loadMdfEffectivePlacement } from './mdf-effective-placement';
import { loadMdfDetachedPositions } from './mdf-position-detachments';
import { loadMdfClosedOrders } from './mdf-closed-orders';
import type { TransactionClient } from '../../../database/database.types';
import { MdfNeedsAttention, type MdfSourceKind } from '../application/mdf-job-runner';
import type { MdfCorrectionAllocation, MdfCorrectionSource, MdfCorrectionSourceLine } from '../domain/mdf-correction-plan';
import { mdfSum } from '../domain/mdf-quantities';
import { loadMdfExecutionSnapshot, mdfSourceKey, type MdfExecutionHead, type MdfExecutionMetadata } from './mdf-execution-snapshot';
import { mdfLineageRevisionKey, type MdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';
import { loadMdfBazisCompositionRawSnapshot, type MdfBazisRawSnapshot } from './mdf-bazis-composition-snapshot';
import type { MdfValidatedBazisAssignmentState } from '../application/mdf-bazis-assignment-state';
import type { MdfReturnKind } from '../../orders/domain/mdf-production-return';
import type { MdfShadowRow } from './mdf-shadow-source';
import { loadMdfShadowSource } from './mdf-shadow-source';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';

export interface MdfCorrectionSourceRef { kind: MdfReturnKind; id: string }
export interface MdfCorrectionOwner extends QueryResultRow {
  id: number; name: string; createdBy: string | null; managerId: string | null; assigned: string[];
  orderKind: string; deleted: boolean; statusId: number | null; status: string | null; version: string;
}
export interface MdfCorrectionDetailRow extends QueryResultRow {
  orderId: number; detailId: number; detailNumber: number | null; quantity: number; currentRank: number | null;
  statusId: number | null; status: string | null;
}
export interface MdfCorrectionHead extends MdfExecutionHead { version: string }
export interface MdfCorrectionLine extends QueryResultRow {
  evidenceLineId: string; kind: MdfSourceKind; id: string; revision: string; lineKey: string;
  orderId: number; detailId: number; quantity: number; stage: 'membership' | 'cut' | 'laminated';
  evidence: 'derived' | 'physical' | 'declaration'; rework: boolean;
}
export interface MdfCorrectionAllocationRow extends QueryResultRow, MdfCorrectionAllocation {}
export interface MdfCorrectionRawSource {
  rows: MdfShadowRow[];
  stamp: string;
  /** Raw content version; never conflated with server observation sequencing. */
  sourceVersion: string | null;
  /** Fence baseline domain: max(raw version, observation sequence, prior fence sequence). */
  observationBaseline: string | null;
}
export interface MdfCorrectionSnapshot {
  orders: number[];
  sources: Array<{ kind: MdfSourceKind; id: string }>;
  heads: MdfCorrectionHead[];
  lines: MdfCorrectionLine[];
  plannerSources: MdfCorrectionSource[];
  allocations: MdfCorrectionAllocationRow[];
  owners: MdfCorrectionOwner[];
  details: MdfCorrectionDetailRow[];
  metadata: Map<string, MdfExecutionMetadata>;
  lineage: Map<string, MdfValidatedPhysicalLineage>;
  lineageIssues: Map<string, string[]>;
  assignmentStates: Map<string, MdfValidatedBazisAssignmentState>;
  frozenDemand: Map<string, Array<{ orderId: number; detailId: number; quantity: number }>>;
  sourceIssues: Map<string, string[]>;
  published: Map<string, { column: string | null; accepted: string | null; received: string; issues: string[];
    /** Live member ranks the effective column was computed from (bound into the preview digest). */
    memberRanks: (number | null)[] }>;
  rawTarget: MdfCorrectionRawSource;
}

export const MAX_MDF_CORRECTION_ORDERS = 100;
export const MAX_MDF_CORRECTION_SOURCES = 250;
export const MAX_MDF_CORRECTION_ROWS = 5000;
const key = (source: { kind: string; id: string }) => mdfSourceKey(source);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// §5.4e: a position detached in a source is terminal history of that source — it never connects the source to its
// (possibly deleted) order, so detached owners neither expand the closure nor need authorization.
const notDetached = (alias: string) => `NOT EXISTS (SELECT 1 FROM mdf_position_detachments x WHERE x.source_kind=${alias}.source_kind
    AND x.source_id=${alias}.source_id AND x.order_id=${alias}.order_id AND x.detail_id=${alias}.detail_id)`;
const graphEdges = `edges AS (
  SELECT l.source_kind kind,l.source_id id,l.order_id FROM mdf_source_heads h JOIN mdf_evidence_lines l
    ON l.source_kind=h.source_kind AND l.source_id=h.source_id
    AND (l.revision_key=h.accepted_revision_key OR l.revision_key=h.received_revision_key)
    WHERE ${notDetached('l')}
  UNION SELECT e.source_kind,e.source_id,a.order_id FROM mdf_bath_allocations a
    JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.state<>'released' AND ${notDetached('e')}
      AND NOT EXISTS (SELECT 1 FROM mdf_position_detachments x WHERE x.source_kind='bath' AND x.source_id=a.bath_id
        AND x.order_id=a.order_id AND x.detail_id=a.detail_id)
  UNION SELECT 'bath',a.bath_id,a.order_id FROM mdf_bath_allocations a WHERE a.state<>'released'
    AND NOT EXISTS (SELECT 1 FROM mdf_position_detachments x WHERE x.source_kind='bath' AND x.source_id=a.bath_id
      AND x.order_id=a.order_id AND x.detail_id=a.detail_id)
    AND NOT EXISTS (SELECT 1 FROM mdf_evidence_lines e JOIN mdf_position_detachments x ON x.source_kind=e.source_kind
      AND x.source_id=e.source_id AND x.order_id=e.order_id AND x.detail_id=e.detail_id
      WHERE e.evidence_line_id=a.evidence_line_id)
  UNION SELECT d.source_kind,d.source_id,d.order_id FROM mdf_source_heads h JOIN mdf_revision_demand d
    ON d.source_kind=h.source_kind AND d.source_id=h.source_id
    AND (d.revision_key=h.accepted_revision_key OR d.revision_key=h.received_revision_key)
    WHERE ${notDetached('d')}
)`;

/** §5.7b: owners of the target card itself (its own graph edges), for the explicit reopen of closed orders. */
export async function mdfCorrectionTargetOwners(tx: TransactionClient, target: MdfCorrectionSourceRef): Promise<number[]> {
  return (await tx.query<{ id: string }>(`WITH ${graphEdges}
    SELECT DISTINCT order_id::text id FROM edges WHERE kind=$1 AND id=$2 ORDER BY 1 LIMIT $3`,
  [target.kind,target.id,MAX_MDF_CORRECTION_ORDERS + 1])).rows.map(r => Number(r.id)).sort((a,b) => a-b);
}

/** Same bounded connected source/order graph as the allocation worker, including its §5.7b closed-order boundary:
 * never expand through a closed order, except the orders this command reopens (`reopen`: the post-reopen closure). */
export async function discoverMdfCorrectionClosure(tx: TransactionClient, target: MdfCorrectionSourceRef,
  options: { reopen?: readonly number[] } = {}) {
  const reopen = new Set(options.reopen ?? []);
  const sources = new Map<string, { kind: MdfSourceKind; id: string }>([[key(target), target]]);
  const orders = new Set<number>();
  for (let round = 0; round <= MAX_MDF_CORRECTION_ORDERS; round++) {
    const previous = `${sources.size}:${orders.size}`;
    const values = [...sources.values()];
    const ownerRows = (await tx.query<{ id: string }>(`WITH ${graphEdges}
      SELECT DISTINCT order_id::text id FROM edges JOIN unnest($1::text[],$2::text[]) s(kind,id) USING(kind,id)
      LIMIT $3`,[values.map(s => s.kind),values.map(s => s.id),MAX_MDF_CORRECTION_ORDERS + 1])).rows;
    for (const row of ownerRows) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new MdfNeedsAttention('MDF_CORRECTION_INVALID_OWNER');
      orders.add(id);
    }
    if (orders.size > MAX_MDF_CORRECTION_ORDERS) throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
    const closed = await loadMdfClosedOrders(tx,[...orders].filter(id => !reopen.has(id)));
    const linked = (await tx.query<{ kind: MdfSourceKind; id: string }>(`WITH ${graphEdges}
      SELECT DISTINCT kind,id FROM edges WHERE order_id=ANY($1::bigint[]) AND kind<>'order' LIMIT $2`,
    [[...orders].filter(id => !closed.has(id)),MAX_MDF_CORRECTION_SOURCES + 1])).rows;
    for (const row of linked) sources.set(key(row),row);
    if (sources.size > MAX_MDF_CORRECTION_SOURCES) throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
    if (previous === `${sources.size}:${orders.size}`) {
      if (!orders.size) throw new MdfNeedsAttention('MDF_CORRECTION_EMPTY_SCOPE');
      return { orders: [...orders].sort((a,b) => a-b),
        sources: [...sources.values()].sort((a,b) => compare(key(a),key(b))) };
    }
  }
  throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
}

function numeric<T extends { orderId: number; detailId: number; quantity: number }>(rows: readonly T[]) {
  for (const row of rows) if (![row.orderId,row.detailId].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(row.quantity) || row.quantity < 0) throw new MdfNeedsAttention('MDF_CORRECTION_INVALID_EVIDENCE');
}

/** Sources that are NOT in the closure but whose non-released debits a correction of the closure must carry (history of a
 * detached position whose supplier / bath lies outside the closure). They are lock dependencies only: callers take their
 * source locks together with the closure's in the canonical order, and the snapshot locks their heads before any
 * allocation lock (same order as every other writer), then re-checks the set. Never authorized or disclosed. */
export async function discoverMdfHistorySuppliers(tx: TransactionClient,
  sources: readonly { kind: string; id: string }[]): Promise<Array<{ kind: MdfSourceKind; id: string }>> {
  if (!sources.length) return [];
  // The closure is excluded IN SQL and the bound applies to the complete lock set (closure + suppliers): a truncated
  // result is never treated as complete — overflow refuses before any head or allocation lock.
  const budget = MAX_MDF_CORRECTION_SOURCES - sources.length;
  if (budget < 0) throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
  const rows = (await tx.query<{ kind: MdfSourceKind; id: string }>(`WITH s AS (SELECT * FROM unnest($1::text[],$2::text[]) s(kind,id)),
    found AS (
      SELECT e.source_kind kind,e.source_id id FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
        WHERE a.state<>'released' AND a.bath_id IN (SELECT id FROM s WHERE kind='bath')
      UNION SELECT 'bath',a.bath_id FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
        WHERE a.state<>'released' AND (e.source_kind,e.source_id) IN (SELECT kind,id FROM s))
    SELECT DISTINCT kind,id FROM found WHERE (kind,id) NOT IN (SELECT kind,id FROM s) ORDER BY 1,2 LIMIT $3`,
  [sources.map(x => x.kind), sources.map(x => x.id), budget + 1])).rows;
  if (rows.length > budget) throw new MdfNeedsAttention('MDF_CORRECTION_SCOPE_LIMIT');
  return rows;
}

export async function loadMdfCorrectionSnapshot(tx: TransactionClient, target: MdfCorrectionSourceRef,
  closure: { orders: number[]; sources: Array<{ kind: MdfSourceKind; id: string }> },
  options: { detachmentAware?: boolean; supplementalSources?: ReadonlyArray<{ kind: MdfSourceKind; id: string }> } = {}): Promise<MdfCorrectionSnapshot> {
  const supplemental = options.supplementalSources ?? [];
  const lockSources = [...closure.sources, ...supplemental];
  const lockedHeads = (await tx.query<MdfCorrectionHead>(`SELECT h.source_kind kind,h.source_id id,
    h.received_revision_key received,h.accepted_revision_key accepted,h.correction_epoch::text epoch,h.version::text version
    FROM mdf_source_heads h JOIN unnest($1::text[],$2::text[]) s(kind,id)
      ON h.source_kind=s.kind AND h.source_id=s.id ORDER BY h.source_kind,h.source_id FOR UPDATE OF h`,
  [lockSources.map(s => s.kind),lockSources.map(s => s.id)])).rows;
  const closureKeys = new Set(closure.sources.map(s => key(s)));
  const heads = lockedHeads.filter(h => closureKeys.has(key(h)));
  if (heads.length !== closure.sources.length) throw new MdfNeedsAttention('MDF_CORRECTION_HEAD_MISSING');
  // §5.4e/§5.5: the return planner models detached positions (history only: no status effects, no credit); BASIS
  // composition does not model detachments of ITS OWN positions yet, so without `detachmentAware` a detachment in the
  // target source fails closed. A neighbour's detachment is that neighbour's history and never blocks the target.
  const detached = await loadMdfDetachedPositions(tx, closure.sources);
  if (!options.detachmentAware && detached.get(JSON.stringify([target.kind, target.id]))?.size) {
    throw new ApiError(409,'MDF_CORRECTION_DETACHED_UNSUPPORTED',
      'В карточке есть выбывшие позиции заказа — возврат и изменение состава для неё пока недоступны');
  }
  if (target.kind==='packet') {
    const packet = (await tx.query<{sourceVersion:string}>(`SELECT source_version::text "sourceVersion"
      FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`,[target.id])).rows[0];
    if (!packet || !/^[1-9]\d*$/.test(packet.sourceVersion)) throw new MdfNeedsAttention('MDF_CORRECTION_SOURCE_UNAVAILABLE');
  }
  const lineRows = (await tx.query<MdfCorrectionLine>(`SELECT l.evidence_line_id::text "evidenceLineId",l.source_kind kind,l.source_id id,
    l.revision_key revision,l.line_key "lineKey",l.order_id::float8 "orderId",l.detail_id::float8 "detailId",
    l.quantity::float8 quantity,l.stage_code stage,l.evidence_kind evidence,l.rework
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) h(kind,id,accepted,received)
    JOIN mdf_evidence_lines l ON l.source_kind=h.kind AND l.source_id=h.id
      AND (l.revision_key=h.accepted OR l.revision_key=h.received)
    ORDER BY l.source_kind,l.source_id,l.revision_key,l.line_key,l.evidence_line_id LIMIT $5`,
  [heads.map(h => h.kind),heads.map(h => h.id),heads.map(h => h.accepted),heads.map(h => h.received),MAX_MDF_CORRECTION_ROWS + 1])).rows;
  if (lineRows.length > MAX_MDF_CORRECTION_ROWS) throw new MdfNeedsAttention('MDF_CORRECTION_ROW_LIMIT');
  numeric(lineRows);
  // Raw BASIS header/rows lock in the worker's canonical order: after owner,
  // source and head locks, before bath allocation locks. For an emptied set
  // the shadow join returns no relevant row, so this locked snapshot is also
  // the proof that the actual set still exists.
  let bazisRaw: MdfBazisRawSnapshot | null = null;
  if (target.kind==='bazisCutSet') {
    try {
      bazisRaw = await loadMdfBazisCompositionRawSnapshot(tx,{setId:Number(target.id),lockRowsAfterOwnerLocks:true});
    } catch (error) {
      if (error instanceof Error && error.message==='MDF_BAZIS_SNAPSHOT_ROW_LIMIT')
        throw new MdfNeedsAttention('MDF_CORRECTION_RAW_LIMIT');
      if (error instanceof Error && ['MDF_BAZIS_SET_NOT_FOUND','MDF_BAZIS_SNAPSHOT_INVALID'].includes(error.message))
        throw new MdfNeedsAttention('MDF_CORRECTION_SOURCE_UNAVAILABLE');
      throw error;
    }
  }
  const allocationRows = (await tx.query<MdfCorrectionAllocationRow>(`SELECT a.allocation_id::text "allocationId",
    a.evidence_line_id::text "evidenceLineId",e.source_kind "evidenceSourceKind",e.source_id "evidenceSourceId",
    e.revision_key "evidenceRevision",a.bath_id "bathId",a.bath_revision "bathRevision",
    a.order_id::float8 "orderId",a.detail_id::float8 "detailId",a.quantity::float8 quantity,a.state
    FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
    WHERE a.state<>'released' AND (a.order_id=ANY($1::bigint[])
      -- Detached owners are outside the closure orders, but their debits on the closure's own sources/baths still
      -- point at the revisions a correction replaces: load them so they are carried as history.
      OR (e.source_kind,e.source_id) IN (SELECT * FROM unnest($3::text[],$4::text[]))
      OR a.bath_id=ANY($5::text[]))
    ORDER BY a.allocation_id LIMIT $2 FOR UPDATE OF a`,[closure.orders,MAX_MDF_CORRECTION_ROWS + 1,
    closure.sources.map(s => s.kind),closure.sources.map(s => s.id),
    closure.sources.filter(s => s.kind === 'bath').map(s => s.id)])).rows;
  if (allocationRows.length > MAX_MDF_CORRECTION_ROWS) throw new MdfNeedsAttention('MDF_CORRECTION_ROW_LIMIT');
  // The lock dependencies must still be exactly the history suppliers now that the allocations are locked.
  const suppliersNow = await discoverMdfHistorySuppliers(tx, closure.sources);
  if (JSON.stringify(suppliersNow.map(x => key(x)).sort()) !== JSON.stringify(supplemental.map(x => key(x)).sort())) {
    throw new ApiError(409, 'MDF_CORRECTION_SCOPE_CHANGED', 'Связанные производственные данные изменились — повторите');
  }
  numeric(allocationRows);

  const owners = (await tx.query<MdfCorrectionOwner>(`SELECT o.order_id::float8 id,o.order_name name,
    o.created_by::text "createdBy",o.manager_id::text "managerId",o.order_kind "orderKind",o.delete_flag deleted,
    o.order_status_id::integer "statusId",os.order_status_name status,o.version::text version,
    ARRAY(SELECT u.user_id::text FROM order_workshops w JOIN users u ON u.employee_id=w.responsible_employee_id
      WHERE w.order_id=o.order_id AND NOT w.delete_flag AND u.is_active ORDER BY u.user_id) assigned
    FROM orders o LEFT JOIN order_statuses os ON os.order_status_id=o.order_status_id
    WHERE o.order_id=ANY($1::bigint[]) ORDER BY o.order_id`,[closure.orders])).rows;
  if (owners.length !== closure.orders.length) throw new MdfNeedsAttention('MDF_CORRECTION_OWNER_MISSING');
  const details = (await tx.query<MdfCorrectionDetailRow>(`SELECT d.order_id::float8 "orderId",d.detail_id::float8 "detailId",
    d.detail_number "detailNumber",d.quantity::float8 quantity,s.sort_order "currentRank",
    d.production_status_id::integer "statusId",s.production_status_name status
    FROM order_details d JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag AND o.order_kind='production_order'
    LEFT JOIN production_statuses s ON s.production_status_id=d.production_status_id
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE d.order_id=ANY($1::bigint[]) AND NOT d.delete_flag
      AND COALESCE(mt.name,m.material_name,'') ~* $2 AND COALESCE(mt.name,m.material_name,'') !~* $3
    ORDER BY d.order_id,d.detail_id LIMIT $4`,[closure.orders,MDF,OTHER,MAX_MDF_CORRECTION_ROWS + 1])).rows;
  if (details.length > MAX_MDF_CORRECTION_ROWS) throw new MdfNeedsAttention('MDF_CORRECTION_ROW_LIMIT');
  numeric(details);
  const execution = await loadMdfExecutionSnapshot(tx,heads,closure.orders);
  const sourceKeys = new Map(heads.map(h => [key(h),h]));
  const plannerSources: MdfCorrectionSource[] = closure.sources.map(source => {
    const head = sourceKeys.get(key(source));
    if (!head) throw new MdfNeedsAttention('MDF_CORRECTION_HEAD_MISSING');
    const issue = execution.issues.get(key(source)) ?? ['MDF_CONTEXT_REQUIRED'];
    const revision = head.accepted;
    const lineageKey = revision ? mdfLineageRevisionKey(source,revision) : null;
    const lineageIssue = lineageKey ? execution.lineageIssues.get(lineageKey)?.[0] : undefined;
    return { kind: source.kind,id: source.id,acceptedRevision: head.accepted,receivedRevision: head.received,
      verified: issue.length===0 && Boolean(head.accepted) && head.accepted===head.received,
      lineage: lineageKey ? execution.lineage.get(lineageKey) : undefined,
      lineageIssue,
      assignmentState: revision ? execution.assignmentStates.get(mdfLineageRevisionKey(source,revision)) : undefined,
      lines: lineRows.filter(l => key(l)===key(source)).map(line => ({ ...line })) as MdfCorrectionSourceLine[],
      ...(detached.get(key(source))?.size ? { detachedPositionKeys: detached.get(key(source)) } : {}) };
  });
  const publishedRows = (await tx.query<{kind:MdfSourceKind;id:string;column:string|null;accepted:string|null;received:string;issues:string[]}>(`SELECT
    source_kind kind,source_id id,column_key "column",accepted_revision_key accepted,received_revision_key received,issues
    FROM mdf_published_sources WHERE (source_kind,source_id) IN (SELECT * FROM unnest($1::text[],$2::text[]))`,
  [closure.sources.map(s => s.kind),closure.sources.map(s => s.id)])).rows;
  // §5.4d: the correction validates and digests the EFFECTIVE column (live member ranks, locked FOR SHARE
  // to commit); unusable placement inputs make the card unavailable for a return.
  const placements = await loadMdfEffectivePlacement(tx,publishedRows,{ lock: true });
  const published = new Map(publishedRows.map(row => {
    const placement = placements.get(key(row));
    return [key(row),{ column:placement?.column ?? row.column,accepted:row.accepted,received:row.received,
      issues:placement?.issues.length ? [...new Set([...row.issues,...placement.issues])] : row.issues,
      memberRanks:placement?.memberRanks ?? [] }];
  }));

  const rawTarget = await loadRawTarget(tx,target,bazisRaw);
  return { ...closure, heads,lines:lineRows,plannerSources,allocations:allocationRows,owners,details,
    metadata:execution.metadata,frozenDemand:new Map([...execution.frozenDemand].map(([k,demand])=>[k,[...demand]])),
    lineage:execution.lineage,lineageIssues:execution.lineageIssues,assignmentStates:execution.assignmentStates,
    sourceIssues:execution.issues,published,rawTarget };
}

async function loadRawTarget(tx: TransactionClient, target: MdfCorrectionSourceRef,
  bazisRaw: MdfBazisRawSnapshot | null): Promise<MdfCorrectionRawSource> {
  const rows = await loadMdfShadowSource(tx,target,MAX_MDF_CORRECTION_ROWS + 1);
  if (rows.length > MAX_MDF_CORRECTION_ROWS) throw new MdfNeedsAttention('MDF_CORRECTION_RAW_LIMIT');
  const rowShape = (row:MdfShadowRow) => [row.line_key,row.order_id,row.detail_id,row.quantity,row.relevant,row.cut,
    row.laminated,row.rework,row.unresolved,row.whole_order,row.stamp];
  rows.sort((a,b) => {
    const left=JSON.stringify(rowShape(a)),right=JSON.stringify(rowShape(b));
    return left<right?-1:left>right?1:0;
  });
  let sourceVersion: string | null = null;
  let observationBaseline: string | null = null;
  if (target.kind==='packet') {
    const packet = (await tx.query<{sourceVersion:string;stamp:string}>(`SELECT source_version::text "sourceVersion",
      concat_ws(':',source_version,updated_at) stamp FROM cnc_telegram_packets WHERE packet_id=$1::uuid`,[target.id])).rows[0];
    if (!packet || !/^[1-9]\d*$/.test(packet.sourceVersion)) throw new MdfNeedsAttention('MDF_CORRECTION_SOURCE_UNAVAILABLE');
    sourceVersion=packet.sourceVersion;
    // The packet row has already been locked by loadMdfCorrectionSnapshot.
    // Lock observation/fence state only after it, matching the observer suffix.
    const targetVersion=(await tx.query<{version:string}>(`SELECT last_observation_version::text version
      FROM mdf_cnc_observation_targets WHERE packet_id=$1::uuid FOR UPDATE`,[target.id])).rows[0]?.version;
    const fence=(await tx.query<{baseline:string;pending:string|null;completion:string|null}>(`SELECT
      baseline_source_version::text baseline,pending_source_version::text pending,
      completion_source_version::text completion FROM mdf_cnc_return_fences WHERE packet_id=$1::uuid FOR UPDATE`,[target.id])).rows[0];
    const versions=[sourceVersion,targetVersion,fence?.baseline,fence?.pending,fence?.completion]
      .filter((value): value is string => Boolean(value));
    if (versions.some(value=>!/^[1-9]\d*$/.test(value))) throw new MdfNeedsAttention('MDF_CORRECTION_SOURCE_UNAVAILABLE');
    observationBaseline=versions.reduce((max,value)=>BigInt(value)>BigInt(max)?value:max);
    return { rows,stamp:createHash('sha256').update(JSON.stringify([rows.map(rowShape),packet.stamp])).digest('hex'),
      sourceVersion,observationBaseline };
  }
  if (target.kind==='bazisCutSet') {
    if (!bazisRaw) throw new MdfNeedsAttention('MDF_CORRECTION_SOURCE_UNAVAILABLE');
    return { rows,stamp:createHash('sha256').update(JSON.stringify([rows.map(rowShape),bazisRaw.rawSnapshotDigest])).digest('hex'),
      sourceVersion,observationBaseline };
  }
  return { rows,stamp:createHash('sha256').update(JSON.stringify(rows.map(rowShape))).digest('hex'),sourceVersion,observationBaseline };
}

export function mdfCorrectionComposition(rows: readonly {orderId:number;detailId:number;quantity:number;rework:boolean}[]): string {
  const totals = new Map<string,number>();
  for (const row of rows) {
    const key = JSON.stringify([row.orderId,row.detailId,row.rework]);
    totals.set(key,mdfSum(totals.get(key)??0,row.quantity));
  }
  return JSON.stringify([...totals].sort(([a],[b]) => compare(a,b)));
}
import { createHash } from 'node:crypto';
