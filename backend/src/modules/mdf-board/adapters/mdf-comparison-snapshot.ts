import type { DatabaseClient } from '../../../database/database.types';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import type { MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import { loadReturnSnapshot } from '../../orders/adapters/mdf-return-snapshot';
import { prepareMdfShadow } from '../application/mdf-shadow';
import type { MdfAllocation } from '../domain/mdf-allocation';
import type { ShadowComparisonInput, ShadowDetail, ShadowSource } from '../domain/mdf-shadow-comparison';
import { loadMdfShadowSource } from './mdf-shadow-source';

export class ShadowScopeError extends Error {
  constructor(readonly code: string) { super(code); }
}
const MAX_OWNERS = 100, MAX_SOURCES = 250, MAX_ROWS = 5000;
const key = (s: MdfBoardSource) => `${s.kind}:${s.id}`;

// Includes archived/hidden/history members: visibility must not free supply.
// Ambiguous names retain all possible owners here, then strict raw identity
// validation blocks accounting. No guessed identity becomes physical evidence.
const memberships = `members AS (
  SELECT 'packet'::text kind,i.packet_id::text id,COALESCE(i.match_order_id,o.order_id) order_id
  FROM cnc_telegram_packet_items i LEFT JOIN orders o
    ON i.match_order_id IS NULL AND lower(trim(o.order_name))=lower(trim(i.order_name)) AND NOT o.delete_flag
  UNION SELECT 'packet',w.packet_id::text,o.order_id FROM cnc_telegram_packet_whole_order_keys w
    JOIN orders o ON lower(trim(o.order_name))=w.order_key AND NOT o.delete_flag
  UNION SELECT 'bazisCutSet',i.bazis_cut_set_id::text,COALESCE(i.source_order_id,d.order_id)
    FROM bazis_cut_set_details i LEFT JOIN order_details d ON d.detail_id=i.source_order_detail_id
  UNION SELECT 'bath','cut-result:'||p.cut_result_id::text,p.order_id
    FROM cut_result_placement p JOIN cut_result_sheet_map s ON s.cut_result_sheet_map_id=p.cut_result_sheet_map_id AND s.is_effective
    JOIN cut_result_board_projection b ON b.cut_result_id=p.cut_result_id AND b.is_vacuum
)`;

/** Closure completed before hydration; SQL sentinel limits reject partial scope. */
export async function discoverMdfComparisonScope(db: DatabaseClient, trigger: MdfBoardSource) {
  const owners = new Set<number>();
  const sources = new Map<string, MdfBoardSource>([[key(trigger), trigger]]);
  for (let round = 0; round <= MAX_OWNERS; round++) {
    const before = `${owners.size}:${sources.size}`;
    const memberRows = await db.query<{ order_id: string }>(`WITH ${memberships}
      SELECT DISTINCT order_id FROM members WHERE (kind||':'||id)=ANY($1::text[]) AND order_id IS NOT NULL
      ORDER BY order_id LIMIT $2`, [[...sources.keys()], MAX_OWNERS + 1]);
    for (const r of memberRows.rows) owners.add(Number(r.order_id));
    if (owners.size > MAX_OWNERS) throw new ShadowScopeError('OWNER_LIMIT');
    const linked = await db.query<{ kind: ShadowSource['kind']; id: string }>(`WITH ${memberships}
      SELECT DISTINCT kind,id FROM members WHERE order_id=ANY($1::bigint[]) ORDER BY kind,id LIMIT $2`,
    [[...owners], MAX_SOURCES + 1]);
    for (const s of linked.rows) sources.set(key(s), s);
    if (sources.size > MAX_SOURCES) throw new ShadowScopeError('SOURCE_LIMIT');
    if (`${owners.size}:${sources.size}` === before) {
      if (!owners.size) throw new ShadowScopeError('UNRESOLVED_OWNERS');
      return { ownerIds: [...owners].sort((a,b) => a-b), sources: [...sources.values()].sort((a,b) => key(a).localeCompare(key(b))) };
    }
  }
  throw new ShadowScopeError('CLOSURE_LIMIT');
}

async function header(db: DatabaseClient, source: MdfBoardSource) {
  const sql = source.kind === 'packet'
    ? `SELECT COALESCE(p.source_created_at,p.created_at)::text created_at,
        NOT COALESCE(p.mdf_completion_returned,false) AND (p.completion_status='completed' OR p.thumbs_up) raw_cut
       FROM cnc_telegram_packets p WHERE p.packet_id::text=$2`
    : source.kind === 'bazisCutSet'
      ? `SELECT created_at::text,false raw_cut FROM bazis_cut_sets WHERE bazis_cut_set_id::text=$2`
      : `SELECT created_at::text,false raw_cut FROM cut_result WHERE 'cut-result:'||cut_result_id::text=$2`;
  return (await db.query<{ created_at: string; raw_cut: boolean; target_column: string | null }>(
    `SELECT h.*,m.target_column FROM (${sql}) h LEFT JOIN mdf_board_manual_moves m ON m.card_kind=$1 AND m.card_id=$2`,
    [source.kind, source.id])).rows[0];
}

export async function loadMdfComparisonSnapshot(db: DatabaseClient, trigger: MdfBoardSource): Promise<{
  input: ShadowComparisonInput; sourceDigest: string; snapshotAt: string; ownerCount: number; sourceCount: number;
}> {
  const dates = (await db.query<{ snapshot_at: string; date_from: string; date_to: string }>(
    `SELECT transaction_timestamp()::text snapshot_at,(current_date-interval '2 months')::date::text date_from,current_date::text date_to`)).rows[0];
  const scope = await discoverMdfComparisonScope(db, trigger);
  const details = (await db.query<ShadowDetail & { relevant: boolean }>(`SELECT d.order_id::integer "orderId",d.detail_id::integer "detailId",
    d.quantity,s.sort_order rank,(COALESCE(mt.name,m.material_name,'') ~* $2 AND COALESCE(mt.name,m.material_name,'') !~* $3) relevant
    FROM order_details d JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag AND o.order_kind='production_order'
    LEFT JOIN production_statuses s ON s.production_status_id=d.production_status_id
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE d.order_id=ANY($1::bigint[]) AND NOT d.delete_flag ORDER BY d.order_id,d.detail_id LIMIT $4`,
  [scope.ownerIds, MDF, OTHER, MAX_ROWS + 1])).rows;
  if (details.length > MAX_ROWS) throw new ShadowScopeError('DETAIL_LIMIT');
  const sources: ShadowSource[] = [];
  let sourceDigest = '', rowCount = details.length;
  for (const source of scope.sources) {
    const rows = await loadMdfShadowSource(db, source, MAX_ROWS - rowCount + 1);
    rowCount += rows.length;
    if (rowCount > MAX_ROWS) throw new ShadowScopeError('ROW_LIMIT');
    const prepared = prepareMdfShadow(rows), meta = await header(db, source);
    if (key(source) === key(trigger)) sourceDigest = prepared.sourceDigest;
    const issues = prepared.issues.filter(i => i !== 'SHADOW_ONLY' && i !== 'INCOMPLETE_PRODUCER_COVERAGE');
    if (!meta || !Number.isFinite(Date.parse(meta.created_at))) issues.push('SOURCE_METADATA_MISSING');
    sources.push({ ...source, revision: prepared.sourceDigest, createdAt: meta?.created_at ?? '1970-01-01',
      members: prepared.lines.filter(l => l.stageCode === 'membership').map(l => ({ orderId: l.orderId,
        detailId: l.detailId, quantity: l.quantity, line: l.lineKey })), issues,
      rawCut: Boolean(meta?.raw_cut), rework: rows.some(r => r.rework), manual: meta?.target_column ?? null, legacyColumn: null });
  }
  // Guard before legacy hydration as well: every legacy owner/source must be
  // contained in the independently discovered closure.
  const legacy = await loadReturnSnapshot(db, trigger, scope.ownerIds, { dateFrom: dates.date_from, dateTo: dates.date_to });
  if (legacy.orders.length > MAX_OWNERS || legacy.cards.length > MAX_SOURCES
      || legacy.details.length > MAX_ROWS || legacy.cards.reduce((n,c) => n+c.members.length, 0) > MAX_ROWS) {
    throw new ShadowScopeError('LEGACY_SCOPE_LIMIT');
  }
  if (legacy.cards.some(c => !scope.sources.some(s => key(s) === key(c)))
      || legacy.orders.some(o => !scope.ownerIds.includes(o.id))) throw new ShadowScopeError('LEGACY_SCOPE_OUTSIDE_CLOSURE');
  for (const s of sources) s.legacyColumn = legacy.cards.find(c => key(c) === key(s))?.column ?? null;
  const thresholds = (await db.query<{ packed: number | null; issued: number | null; laminated: number | null }>(`SELECT
    MIN(sort_order) FILTER(WHERE production_status_code='packed' OR lower(trim(production_status_name))='упакован') packed,
    MIN(sort_order) FILTER(WHERE production_status_code='issued' OR lower(trim(production_status_name))='выдан') issued,
    MIN(sort_order) FILTER(WHERE production_status_code='laminated' OR lower(trim(production_status_name))='закатан') laminated
    FROM production_statuses`)).rows[0];
  const allocations = (await db.query<MdfAllocation>(`SELECT bath_id "bathId",bath_revision "bathRevision",
    order_id::integer "orderId",detail_id::integer "detailId",quantity::float8 quantity,state
    FROM mdf_bath_allocations WHERE order_id=ANY($1::bigint[]) AND state<>'released' LIMIT $2`,
  [scope.ownerIds, MAX_ROWS + 1])).rows;
  if (allocations.length > MAX_ROWS) throw new ShadowScopeError('ALLOCATION_LIMIT');
  const issues: string[] = [];
  if (legacy.cards.some(c => c.members.some(m => !m.orderId || !m.detailId))) issues.push('LEGACY_IDENTITY_FALLBACK_NOT_COMPARABLE');
  if (!details.some(d => d.relevant)) issues.push('NO_LIVE_MDF_DEMAND');
  return { input: { sources, details: details.filter(d => d.relevant), legacyCards: legacy.cards, thresholds, allocations, issues },
    sourceDigest, snapshotAt: dates.snapshot_at, ownerCount: scope.ownerIds.length, sourceCount: scope.sources.length };
}
