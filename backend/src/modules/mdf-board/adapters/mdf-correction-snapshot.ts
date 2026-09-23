import type { QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import { MdfNeedsAttention, type MdfSourceKind } from '../application/mdf-job-runner';
import type { MdfCorrectionAllocation, MdfCorrectionSource, MdfCorrectionSourceLine } from '../domain/mdf-correction-plan';
import { mdfSum } from '../domain/mdf-quantities';
import { loadMdfExecutionSnapshot, mdfSourceKey, type MdfExecutionHead, type MdfExecutionMetadata } from './mdf-execution-snapshot';
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
  frozenDemand: Map<string, Array<{ orderId: number; detailId: number; quantity: number }>>;
  sourceIssues: Map<string, string[]>;
  published: Map<string, { column: string | null; accepted: string | null; received: string; issues: string[] }>;
  rawTarget: MdfCorrectionRawSource;
}

export const MAX_MDF_CORRECTION_ORDERS = 100;
export const MAX_MDF_CORRECTION_SOURCES = 250;
export const MAX_MDF_CORRECTION_ROWS = 5000;
const key = (source: { kind: string; id: string }) => mdfSourceKey(source);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const graphEdges = `edges AS (
  SELECT l.source_kind kind,l.source_id id,l.order_id FROM mdf_source_heads h JOIN mdf_evidence_lines l
    ON l.source_kind=h.source_kind AND l.source_id=h.source_id
    AND (l.revision_key=h.accepted_revision_key OR l.revision_key=h.received_revision_key)
  UNION SELECT e.source_kind,e.source_id,a.order_id FROM mdf_bath_allocations a
    JOIN mdf_evidence_lines e USING(evidence_line_id) WHERE a.state<>'released'
  UNION SELECT 'bath',bath_id,order_id FROM mdf_bath_allocations WHERE state<>'released'
  UNION SELECT d.source_kind,d.source_id,d.order_id FROM mdf_source_heads h JOIN mdf_revision_demand d
    ON d.source_kind=h.source_kind AND d.source_id=h.source_id
    AND (d.revision_key=h.accepted_revision_key OR d.revision_key=h.received_revision_key)
)`;

/** Same bounded connected source/order graph as the allocation worker. */
export async function discoverMdfCorrectionClosure(tx: TransactionClient, target: MdfCorrectionSourceRef) {
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
    const linked = (await tx.query<{ kind: MdfSourceKind; id: string }>(`WITH ${graphEdges}
      SELECT DISTINCT kind,id FROM edges WHERE order_id=ANY($1::bigint[]) LIMIT $2`,[[...orders],MAX_MDF_CORRECTION_SOURCES + 1])).rows;
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

export async function loadMdfCorrectionSnapshot(tx: TransactionClient, target: MdfCorrectionSourceRef,
  closure: { orders: number[]; sources: Array<{ kind: MdfSourceKind; id: string }> }): Promise<MdfCorrectionSnapshot> {
  const heads = (await tx.query<MdfCorrectionHead>(`SELECT h.source_kind kind,h.source_id id,
    h.received_revision_key received,h.accepted_revision_key accepted,h.correction_epoch::text epoch,h.version::text version
    FROM mdf_source_heads h JOIN unnest($1::text[],$2::text[]) s(kind,id)
      ON h.source_kind=s.kind AND h.source_id=s.id ORDER BY h.source_kind,h.source_id FOR UPDATE OF h`,
  [closure.sources.map(s => s.kind),closure.sources.map(s => s.id)])).rows;
  if (heads.length !== closure.sources.length) throw new MdfNeedsAttention('MDF_CORRECTION_HEAD_MISSING');
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
  const allocationRows = (await tx.query<MdfCorrectionAllocationRow>(`SELECT a.allocation_id::text "allocationId",
    a.evidence_line_id::text "evidenceLineId",e.source_kind "evidenceSourceKind",e.source_id "evidenceSourceId",
    e.revision_key "evidenceRevision",a.bath_id "bathId",a.bath_revision "bathRevision",
    a.order_id::float8 "orderId",a.detail_id::float8 "detailId",a.quantity::float8 quantity,a.state
    FROM mdf_bath_allocations a JOIN mdf_evidence_lines e USING(evidence_line_id)
    WHERE a.order_id=ANY($1::bigint[]) AND a.state<>'released'
    ORDER BY a.allocation_id LIMIT $2 FOR UPDATE OF a`,[closure.orders,MAX_MDF_CORRECTION_ROWS + 1])).rows;
  if (allocationRows.length > MAX_MDF_CORRECTION_ROWS) throw new MdfNeedsAttention('MDF_CORRECTION_ROW_LIMIT');
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
    return { kind: source.kind,id: source.id,acceptedRevision: head.accepted,receivedRevision: head.received,
      verified: issue.length===0 && Boolean(head.accepted) && head.accepted===head.received,
      lines: lineRows.filter(l => key(l)===key(source)).map(line => ({ ...line })) as MdfCorrectionSourceLine[] };
  });
  const publishedRows = (await tx.query<{kind:MdfSourceKind;id:string;column:string|null;accepted:string|null;received:string;issues:string[]}>(`SELECT
    source_kind kind,source_id id,column_key "column",accepted_revision_key accepted,received_revision_key received,issues
    FROM mdf_published_sources WHERE (source_kind,source_id) IN (SELECT * FROM unnest($1::text[],$2::text[]))`,
  [closure.sources.map(s => s.kind),closure.sources.map(s => s.id)])).rows;
  const published = new Map(publishedRows.map(row => [key(row),{ column:row.column,accepted:row.accepted,received:row.received,issues:row.issues }]));

  const rawTarget = await loadRawTarget(tx,target);
  return { ...closure, heads,lines:lineRows,plannerSources,allocations:allocationRows,owners,details,
    metadata:execution.metadata,frozenDemand:new Map([...execution.frozenDemand].map(([k,demand])=>[k,[...demand]])),
    sourceIssues:execution.issues,published,rawTarget };
}

async function loadRawTarget(tx: TransactionClient, target: MdfCorrectionSourceRef): Promise<MdfCorrectionRawSource> {
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
