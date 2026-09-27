import type { DatabaseClient } from '../../../database/database.types';
import { cncPacketCountsForMdfReadinessSql, CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import { loadMdfReturnSources } from '../../cnc-telegram/adapters/pg-cnc-telegram-repository';
import { flattenReturnCards } from '../../orders/adapters/mdf-return-snapshot';
import { mdfShadowCompositionDigest, prepareMdfShadow } from '../application/mdf-shadow';
import type { MdfReconciliationItem, MdfReconciliationKind, MdfReconciliationSourceInput } from '../domain/mdf-reconciliation';
import { projectMdfShadowProof } from '../domain/mdf-shadow-proof';
import { loadMdfShadowProofs, ShadowProofLimitError } from './mdf-shadow-proof-loader';
import type { ShadowCommandProof } from '../domain/mdf-shadow-proof';
import { loadMdfShadowSource } from './mdf-shadow-source';

/**
 * §5.7a read-only inventory. Batched reads on the caller's REPEATABLE READ READ ONLY snapshot. Item relevance and
 * identity follow `loadMdfShadowSource` exactly (checked per source by `checkMdfShadowParity`); owner state is split
 * further (deleted / not a production order / missing) only for the report reason.
 */
export interface MdfReconciliationReference { kind: MdfReconciliationKind; id: string; origin: string }
export interface MdfReconciliationOrder { id: number; name: string; status: string | null; deleted: boolean; kind: string;
  /** Order status at or after «Готов к выдаче» by the status catalogue order (includes «Выдан», «Завершен»). */
  readyOrLater: boolean }
export interface MdfReconciliationDemandRow { orderId: number; detailId: number; quantity: number; rank: number | null }
export interface MdfReconciliationInventory {
  inputs: MdfReconciliationSourceInput[];
  references: { total: number; byOrigin: Record<string, number>;
    /** History subjects that name something that is not a board source (upload files, cut jobs). */
    nonSource: { reason: string; entityType: string; subjects: number }[] };
  demand: MdfReconciliationDemandRow[];
  orders: Map<number, MdfReconciliationOrder>;
  thresholds: { packed: number | null; issued: number | null; laminated: number | null };
}

const material = (value: string) => `(COALESCE(${value},'') ~* $1 AND COALESCE(${value},'') !~* $2)`;
// Owner state of one raw identity: live / deleted / not a production order / missing (unmatched or absent row).
const ownerState = (matched: string) => `CASE WHEN NOT (${matched}) OR d.detail_id IS NULL OR o.order_id IS NULL THEN 'missing'
  WHEN d.delete_flag OR o.delete_flag THEN 'deleted' WHEN o.order_kind<>'production_order' THEN 'not_production' ELSE 'live' END`;
// Board subjects whose history row points at a non-source entity (upload file / telegram request / cut job).
const NON_SOURCE_ENTITIES = ['cnc_manual_svg_upload_file', 'cnc_manual_svg_telegram_send_request', 'cut_job'];

type ItemRow = { kind: MdfReconciliationKind; id: string; line: string | null; order_id: string | null; detail_id: string | null;
  quantity: string | null; relevant: boolean; state: MdfReconciliationItem['ownerState'] };
type HeaderRow = { kind: MdfReconciliationKind; id: string; created_at: string; completed: boolean; returned: boolean;
  rework: boolean; source_mdf: boolean };

export async function loadMdfReconciliationInventory(db: DatabaseClient): Promise<MdfReconciliationInventory> {
  const refs = (await db.query<MdfReconciliationReference>(`
    SELECT 'packet' kind,packet_id::text id,'table' origin FROM cnc_telegram_packets
    UNION ALL SELECT 'bazisCutSet',bazis_cut_set_id::text,'table' FROM bazis_cut_sets
    UNION ALL SELECT 'bath','cut-result:'||cut_result_id,'table' FROM cut_result
    UNION ALL SELECT card_kind,card_id,'manual_move' FROM mdf_board_manual_moves WHERE card_kind<>'order'
    UNION ALL SELECT 'bath','cut-result:'||current_cut_result_id,'cut_job' FROM cut_job WHERE current_cut_result_id IS NOT NULL
    UNION ALL SELECT DISTINCT h.subject_kind,CASE WHEN h.subject_kind='bath' AND h.subject_id !~ '^cut-result:' THEN 'cut-result:'||h.subject_id
      ELSE h.subject_id END,
      'history' FROM mdf_board_history_events h
      LEFT JOIN audit_log a ON h.source_event_type='audit_log' AND a.audit_id::text=h.source_event_id
      WHERE h.subject_kind<>'order' AND COALESCE(a.entity_type,'') <> ALL($1::text[])`, [NON_SOURCE_ENTITIES])).rows;
  const nonSource = (await db.query<{ reason: string; entityType: string; subjects: string }>(`
    SELECT h.reason_code reason,a.entity_type "entityType",COUNT(DISTINCT h.subject_kind||':'||h.subject_id)::text subjects
    FROM mdf_board_history_events h JOIN audit_log a ON h.source_event_type='audit_log' AND a.audit_id::text=h.source_event_id
    WHERE h.subject_kind<>'order' AND a.entity_type=ANY($1::text[]) GROUP BY 1,2 ORDER BY 1,2`, [NON_SOURCE_ENTITIES])).rows;
  const byOrigin: Record<string, number> = {};
  const identities = new Map<string, MdfReconciliationReference>();
  for (const r of refs) {
    byOrigin[r.origin] = (byOrigin[r.origin] ?? 0) + 1;
    identities.set(`${r.kind}:${r.id}`, r);
  }

  const headers = new Map((await db.query<HeaderRow>(`
    SELECT 'packet' kind,p.packet_id::text id,COALESCE(p.source_created_at,p.created_at)::text created_at,
      (p.completion_status='completed' OR COALESCE(p.thumbs_up,false)) completed,COALESCE(p.mdf_completion_returned,false) returned,
      COALESCE(p.rework,false) rework,
      (${cncPacketCountsForMdfReadinessSql('p')} AND COALESCE(p.mdf_board_card_kind,'machine_file')='machine_file') source_mdf
    FROM cnc_telegram_packets p
    UNION ALL SELECT 'bazisCutSet',s.bazis_cut_set_id::text,s.created_at::text,false,false,false,true FROM bazis_cut_sets s
    UNION ALL SELECT 'bath','cut-result:'||r.cut_result_id,r.created_at::text,false,false,false,
      COALESCE(b.is_vacuum,false) FROM cut_result r
      LEFT JOIN cut_result_board_projection b ON b.cut_result_id=r.cut_result_id AND b.snapshot_digest=r.snapshot_digest`))
    .rows.map(h => [`${h.kind}:${h.id}`, h]));

  const items = (await db.query<ItemRow>(`
    SELECT 'packet' kind,i.packet_id::text id,i.source_item_key line,i.match_order_id::text order_id,i.match_detail_id::text detail_id,
      i.quantity::text quantity,true relevant,${ownerState(`i.match_status='matched'`)} state
    FROM cnc_telegram_packet_items i
    LEFT JOIN order_details d ON d.detail_id=i.match_detail_id AND d.order_id=i.match_order_id
    LEFT JOIN orders o ON o.order_id=d.order_id
    UNION ALL
    SELECT 'bazisCutSet',i.bazis_cut_set_id::text,i.bazis_cut_set_detail_id::text,
      -- Raw owner kept for diagnostics when the detail link is gone (FK SET NULL); credit still needs the live detail.
      COALESCE(d.order_id,i.source_order_id)::text,d.detail_id::text,
      i.quantity::text,${material('i.material_name')} AND i.cut_enabled,${ownerState('true')}
    FROM bazis_cut_set_details i
    LEFT JOIN order_details d ON d.detail_id=i.source_order_detail_id AND (i.source_order_id IS NULL OR d.order_id=i.source_order_id)
    LEFT JOIN orders o ON o.order_id=d.order_id
    UNION ALL
    SELECT 'bath','cut-result:'||p.cut_result_id,concat_ws(':',p.order_id,p.order_detail_id),p.order_id::text,
      p.order_detail_id::text,COUNT(*)::text,
      ${material('COALESCE(smt.name,m.material_name)')},${ownerState('true')}
    FROM cut_result_placement p JOIN cut_result_sheet_map sheet
      ON sheet.cut_result_sheet_map_id=p.cut_result_sheet_map_id AND sheet.is_effective
    LEFT JOIN order_details d ON d.detail_id=p.order_detail_id AND d.order_id=p.order_id
    LEFT JOIN orders o ON o.order_id=d.order_id
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE p.order_hdf_detail_id IS NULL
    GROUP BY p.cut_result_id,p.order_id,p.order_detail_id,d.detail_id,d.delete_flag,o.order_id,o.delete_flag,o.order_kind,
      smt.name,m.material_name`, [MDF, OTHER])).rows;
  const itemsBySource = new Map<string, ItemRow[]>();
  for (const i of items) { const k = `${i.kind}:${i.id}`; itemsBySource.set(k, [...(itemsBySource.get(k) ?? []), i]); }

  const moves = new Map((await db.query<{ kind: string; id: string; target: string; audited: boolean }>(`
    SELECT m.card_kind kind,m.card_id id,m.target_column target,EXISTS(SELECT 1 FROM audit_log a
      WHERE a.entity_type='mdf_board_manual_move' AND a.entity_id=m.card_kind||':'||m.card_id AND a.status_code=m.target_column
        AND a.event IN ('mdf_board.manual_move.created','mdf_board.manual_move.updated')) audited
    FROM mdf_board_manual_moves m WHERE m.card_kind<>'order'`)).rows.map(m => [`${m.kind}:${m.id}`, m]));

  // Strict audited proofs (composition-bound commands) exactly as the shadow comparison projects them.
  const commanded = (await db.query<{ kind: MdfReconciliationKind; id: string }>(
    `SELECT DISTINCT source_kind kind,source_id id FROM mdf_shadow_commands ORDER BY 1,2`)).rows;
  const { proofs, overflow } = await loadMdfShadowProofsBatched(db, commanded);
  const proven = new Map<string, { cut: boolean; laminated: boolean }>();
  for (const source of commanded) {
    if (overflow.has(`${source.kind}:${source.id}`)) continue;
    const rows = await loadMdfShadowSource(db, source);
    const prepared = prepareMdfShadow(rows);
    const members = prepared.lines.filter(l => l.stageCode === 'membership')
      .map(l => ({ orderId: l.orderId, detailId: l.detailId, quantity: l.quantity, line: l.lineKey }));
    const proof = projectMdfShadowProof({ kind: source.kind, compositionDigest: mdfShadowCompositionDigest(rows), members,
      rework: rows.some(r => r.rework), rawCut: false, issues: [], commands: proofs.get(`${source.kind}:${source.id}`) ?? [] });
    proven.set(`${source.kind}:${source.id}`, { cut: proof.cut && proof.cutRevision !== null, laminated: proof.laminated });
  }

  const inputs: MdfReconciliationSourceInput[] = [...identities.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)).map(ref => {
      const key = `${ref.kind}:${ref.id}`, header = headers.get(key), move = moves.get(key), proof = proven.get(key);
      const relevant = (itemsBySource.get(key) ?? []).filter(i => i.relevant && i.line !== null);
      return {
        kind: ref.kind, id: ref.id, exists: header !== undefined,
        // Packet scope is file-level (material marker); BASIS/bath scope needs at least one MDF row.
        mdf: header !== undefined && header.source_mdf && (ref.kind === 'packet' || relevant.length > 0),
        createdAt: header?.created_at ?? null,
        items: relevant.map(i => ({ line: i.line!, orderId: i.order_id === null ? null : Number(i.order_id),
          detailId: i.detail_id === null ? null : Number(i.detail_id), quantity: Number(i.quantity ?? 0),
          resolved: i.state === 'live', ownerState: i.state })),
        completed: header?.completed, returned: header?.returned, rework: header?.rework,
        manualColumn: move?.target ?? null, manualAudited: move?.audited === true,
        provenCut: proof?.cut === true, provenLaminated: proof?.laminated === true, proofLimit: overflow.has(key),
        legacyColumn: null,
      };
    });

  // Diagnostic order scope, independent of credit: every live production order named by an item of an MDF source
  // (resolved or not), so an order whose sources are all unresolved still shows its zero-credit remaining demand.
  const namedOrderIds = [...new Set(inputs.filter(i => i.exists && i.mdf)
    .flatMap(i => i.items.flatMap(x => x.orderId === null ? [] : [x.orderId])))].sort((a, b) => a - b);
  const liveOrders = new Set((await db.query<{ id: number }>(`SELECT order_id::integer id FROM orders
    WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag AND order_kind='production_order'`, [namedOrderIds])).rows.map(r => r.id));
  const ownerIds = namedOrderIds.filter(id => liveOrders.has(id));
  // Same predicate as `loadMdfExecutionDetails` (live MDF demand), without its per-call limit: the limit is reported.
  const demand = (await db.query<MdfReconciliationDemandRow>(`SELECT d.order_id::float8 "orderId",d.detail_id::float8 "detailId",
    d.quantity::float8 quantity,s.sort_order rank
    FROM order_details d JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag AND o.order_kind='production_order'
    LEFT JOIN production_statuses s ON s.production_status_id=d.production_status_id
    LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE d.order_id=ANY($3::bigint[]) AND NOT d.delete_flag
      AND COALESCE(mt.name,m.material_name,'') ~* $1 AND COALESCE(mt.name,m.material_name,'') !~* $2
    ORDER BY d.order_id,d.detail_id`, [MDF, OTHER, ownerIds])).rows;
  // Credit needs a position inside live MDF demand (the accepted projection rejects MEMBER_OUTSIDE_LIVE_MDF_DEMAND);
  // a live item outside it keeps an explicit reason instead of silent credit.
  const inDemand = new Set(demand.map(d => `${d.orderId}:${d.detailId}`));
  for (const input of inputs) for (const x of input.items) if (x.ownerState === 'live' && !inDemand.has(`${x.orderId}:${x.detailId}`)) {
    x.ownerState = 'outside_demand'; x.resolved = false;
  }
  const orderIds = [...new Set([...ownerIds, ...inputs.flatMap(i => i.items.flatMap(x => x.orderId === null ? [] : [x.orderId]))])];
  const orders = new Map((await db.query<MdfReconciliationOrder>(`SELECT o.order_id::integer id,o.order_name name,
    s.order_status_name status,o.delete_flag deleted,o.order_kind kind,
    COALESCE(s.sort_order >= (SELECT MIN(sort_order) FROM order_statuses
      WHERE lower(trim(order_status_name))='готов к выдаче'),false) "readyOrLater"
    FROM orders o LEFT JOIN order_statuses s ON s.order_status_id=o.order_status_id WHERE o.order_id=ANY($1::bigint[])`,
  [orderIds])).rows.map(o => [o.id, o]));
  const thresholds = (await db.query<MdfReconciliationInventory['thresholds']>(`SELECT
    MIN(sort_order) FILTER(WHERE production_status_code='packed' OR lower(trim(production_status_name))='упакован') packed,
    MIN(sort_order) FILTER(WHERE production_status_code='issued' OR lower(trim(production_status_name))='выдан') issued,
    MIN(sort_order) FILTER(WHERE production_status_code='laminated' OR lower(trim(production_status_name))='закатан') laminated
    FROM production_statuses`)).rows[0];

  // Legacy board column (whole history window), by owner chunks; the same card may appear in several chunks.
  const legacy = new Map<string, string>();
  for (let i = 0; i < ownerIds.length; i += 100) {
    const cards = flattenReturnCards(await loadMdfReturnSources(db, ownerIds.slice(i, i + 100),
      { dateFrom: '2000-01-01', dateTo: '2100-01-01' }));
    for (const c of cards) legacy.set(`${c.kind}:${c.id}`, c.column);
  }
  for (const input of inputs) input.legacyColumn = legacy.get(`${input.kind}:${input.id}`) ?? null;

  return { inputs, references: { total: refs.length, byOrigin,
    nonSource: nonSource.map(n => ({ reason: n.reason, entityType: n.entityType, subjects: Number(n.subjects) })) },
  demand, orders, thresholds };
}

/** Per-source parity with the shadow loader: same relevant membership (line/order/detail/quantity) and resolution. */
export async function checkMdfShadowParity(db: DatabaseClient, inputs: readonly MdfReconciliationSourceInput[]): Promise<string[]> {
  const mismatches: string[] = [];
  for (const input of inputs) {
    if (!input.exists) continue;
    const rows = await loadMdfShadowSource(db, { kind: input.kind, id: input.id });
    const shadow = rows.filter(r => r.relevant && r.line_key !== null && !r.unresolved)
      .map(r => JSON.stringify([r.line_key, Number(r.order_id), Number(r.detail_id), Number(r.quantity)])).sort();
    // The shadow loader distinguishes neither non-production owners nor live MDF demand; they are live rows there.
    const mine = input.items.filter(i => i.resolved || i.ownerState === 'not_production' || i.ownerState === 'outside_demand')
      .map(i => JSON.stringify([i.line, i.orderId, i.detailId, i.quantity])).sort();
    if (input.mdf && JSON.stringify(shadow) !== JSON.stringify(mine)) mismatches.push(`${input.kind}:${input.id}`);
  }
  return mismatches;
}

/** Complete strict proof histories in bounded batches: the loader caps one request at 1000 commands / 10000 lines. A
 * batch over the cap is split; a single source over the cap is reported (`overflow`), never silently truncated. */
export async function loadMdfShadowProofsBatched(db: DatabaseClient, sources: readonly { kind: MdfReconciliationKind; id: string }[],
  loader: typeof loadMdfShadowProofs = loadMdfShadowProofs, batchSize = 50) {
  const proofs = new Map<string, ShadowCommandProof[]>(), overflow = new Set<string>();
  const load = async (batch: readonly { kind: MdfReconciliationKind; id: string }[]): Promise<void> => {
    if (!batch.length) return;
    try {
      for (const [k, v] of await loader(db, batch)) proofs.set(k, v);
    } catch (error) {
      if (!(error instanceof ShadowProofLimitError)) throw error;
      if (batch.length === 1) { overflow.add(`${batch[0].kind}:${batch[0].id}`); return; }
      const half = Math.ceil(batch.length / 2);
      await load(batch.slice(0, half)); await load(batch.slice(half));
    }
  };
  for (let i = 0; i < sources.length; i += batchSize) await load(sources.slice(i, i + batchSize));
  return { proofs, overflow };
}
