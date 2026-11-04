import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { appendOrderReadScopeSql } from '../../../permissions/policies/order-read-scope-sql';
import {
  bathCardIdOf,
  bathOwnerOrderIds,
  buildBathDuplicates,
  type MdfBathDuplicateResolutionFact,
  type MdfBathSideFacts,
} from '../domain/mdf-bath-duplicates';

/**
 * SQL facts of «Разобрать дубль» (plan r8 §2.1), shared by the board read and the resolve command. Plain reads, no
 * row locks (§3 r6/r7): the command's only barrier is the per-bath advisory lock it takes before calling these.
 */

/** Same active bath as the MDF board (loadBathCards): per non-archived job its latest non-archived vacuum result,
 * the current one first, unless its bath card was hidden. `$1` — the jobs. The jobs are joined from an array and the
 * hidden cards read once (hashed): with `= ANY` and a correlated NOT EXISTS the plan rescans both per candidate
 * (stage 30.10, 502 jobs: 117 ms → 13 ms). */
const ACTIVE_BATHS_SQL = `SELECT DISTINCT ON (r.cut_job_id) r.cut_result_id::text AS id
  FROM unnest($1::bigint[]) AS wanted(cut_job_id)
  JOIN cut_job j ON j.cut_job_id = wanted.cut_job_id
  JOIN cut_result r ON r.cut_job_id = j.cut_job_id
  JOIN cut_result_board_projection board ON board.cut_result_id = r.cut_result_id
   AND board.snapshot_digest = r.snapshot_digest AND board.is_vacuum = true
  JOIN cut_result_label_map_projection projection ON projection.cut_result_id = r.cut_result_id
   AND projection.snapshot_digest = r.snapshot_digest
  LEFT JOIN cut_result current_result ON current_result.cut_result_id = j.current_cut_result_id
  LEFT JOIN cut_result_archive_state archive ON archive.cut_job_id = r.cut_job_id AND archive.result_no = r.result_no
  WHERE j.status <> 'archived' AND archive.archived_at IS NULL
    AND r.cut_result_id NOT IN (SELECT hidden_seed.svg_cut_result_id FROM cnc_telegram_packets hidden_seed
      WHERE hidden_seed.mdf_board_card_kind = 'bath_seed' AND hidden_seed.mdf_board_hidden_at IS NOT NULL
        AND hidden_seed.svg_cut_result_id IS NOT NULL)
  ORDER BY r.cut_job_id, (current_result.result_no = r.result_no) DESC, r.created_at DESC, r.result_no DESC,
    r.revision_no DESC, r.cut_result_id DESC`;

/** Active baths (cut_result ids) of the jobs that placed any detail of these orders. */
export async function loadActiveBathIdsForOrders(db: DatabaseClient, orderIds: readonly number[]): Promise<number[]> {
  if (!orderIds.length) return [];
  // Two statements on purpose: inlined as a semi-join the planner misestimates it as one row and rescans the
  // placements per candidate result (stage 30.10: 4.7 s instead of ~30 ms + ~30 ms).
  const jobs = (await db.query<{ id: string }>(`SELECT DISTINCT placed.cut_job_id::text AS id
    FROM cut_result_placement placed WHERE placed.order_id = ANY($1::bigint[])`, [[...orderIds]])).rows.map(row => Number(row.id));
  return loadActiveBathIdsForJobs(db, jobs);
}

/** Active baths (cut_result ids) of these jobs. */
export async function loadActiveBathIdsForJobs(db: DatabaseClient, jobIds: readonly number[]): Promise<number[]> {
  if (!jobIds.length) return [];
  return (await db.query<{ id: string }>(ACTIVE_BATHS_SQL, [[...new Set(jobIds)]]))
    .rows.map(row => Number(row.id));
}

interface HeaderRow { result_id: string; job_id: string; result_no: number; revision_no: number; version: number;
  job_name: string; source_display_number: string | null }
interface PlacementRow { result_id: string; order_id: string; detail_id: string; quantity: number }
interface DetailRow { detail_id: string; detail_number: string | number | null; laminated_or_later: boolean;
  production_round: number | null }
interface CompositionRow { job_id: string; order_id: string; detail_id: string | null; hdf_detail_id: string | null;
  quantity: number }

/** Sides of the given results (active or not): header, effective MDF placements, active job composition, manual
 * column and other linked MDF cards. Unknown ids are absent from the map. */
export async function loadBathSideFacts(db: DatabaseClient,
  resultIds: readonly number[]): Promise<Map<string, MdfBathSideFacts>> {
  if (!resultIds.length) return new Map();
  const ids = [...new Set(resultIds)];
  const cardIds = ids.map(bathCardIdOf);
  const [headers, placements, owners, composition, manual, linked] = await Promise.all([
    db.query<HeaderRow>(`SELECT r.cut_result_id::text AS result_id, r.cut_job_id::text AS job_id,
        r.result_no::int AS result_no, r.revision_no::int AS revision_no, j.version::int AS version,
        COALESCE(board.cut_job_name, j.name, 'Раскрой ' || j.cut_job_id::text) AS job_name,
        j.source_display_number::text AS source_display_number
      FROM cut_result r JOIN cut_job j ON j.cut_job_id = r.cut_job_id
      LEFT JOIN cut_result_board_projection board ON board.cut_result_id = r.cut_result_id
       AND board.snapshot_digest = r.snapshot_digest
      WHERE r.cut_result_id = ANY($1::bigint[])`, [ids]),
    // Same placements as the bath card (effective sheets, MDF positions only). Details are read separately by id:
    // joined here the planner hashes the whole order_details table (stage 30.10: ~200 ms instead of ~15 + ~40 ms).
    db.query<PlacementRow>(`SELECT p.cut_result_id::text AS result_id, p.order_id::text AS order_id,
        p.order_detail_id::text AS detail_id, COUNT(*)::int AS quantity
      FROM cut_result_placement p
      JOIN cut_result_sheet_map sheet ON sheet.cut_result_sheet_map_id = p.cut_result_sheet_map_id AND sheet.is_effective = true
      WHERE p.cut_result_id = ANY($1::bigint[]) AND p.order_hdf_detail_id IS NULL
        AND p.order_id > 0 AND p.order_detail_id > 0
      GROUP BY p.cut_result_id, p.order_id, p.order_detail_id`, [ids]),
    // Every owner of the result's placements (HDF, non-effective sheets too): the scope set, as in the published reader.
    db.query<{ result_id: string; order_id: string }>(`SELECT DISTINCT p.cut_result_id::text AS result_id,
        p.order_id::text AS order_id
      FROM cut_result_placement p WHERE p.cut_result_id = ANY($1::bigint[]) AND p.order_id IS NOT NULL`, [ids]),
    db.query<CompositionRow>(`SELECT i.cut_job_id::text AS job_id, i.order_id::text AS order_id,
        i.order_detail_id::text AS detail_id, i.order_hdf_detail_id::text AS hdf_detail_id, SUM(i.qty)::int AS quantity
      FROM cut_job_item i
      WHERE i.is_active AND i.cut_job_id IN (SELECT r.cut_job_id FROM cut_result r WHERE r.cut_result_id = ANY($1::bigint[]))
      GROUP BY i.cut_job_id, i.order_id, i.order_detail_id, i.order_hdf_detail_id`, [ids]),
    db.query<{ card_id: string; target_column: string }>(`SELECT card_id, target_column FROM mdf_board_manual_moves
      WHERE card_kind = 'bath' AND card_id = ANY($1::text[])`, [cardIds]),
    // Cards the cut archive asks to confirm (deleteLinkedMdfPackets), except this result's own bath_seed.
    db.query<{ result_id: string; count: number }>(`SELECT r.cut_result_id::text AS result_id, COUNT(p.packet_id)::int AS count
      FROM cut_result r
      JOIN cnc_telegram_packets p ON p.svg_cut_job_id = r.cut_job_id AND p.mdf_board_hidden_at IS NULL
       AND NOT (p.mdf_board_card_kind = 'bath_seed' AND p.svg_cut_result_id = r.cut_result_id)
       AND (p.source_chat_id IS DISTINCT FROM 'erp-manual-svg-upload' OR EXISTS (SELECT 1 FROM outbox_events e
         WHERE e.idempotency_key = 'cnc-manual-svg:' || p.packet_id::text || ':source-' || p.source_version::text
           || ':mdf-card-created'))
      WHERE r.cut_result_id = ANY($1::bigint[])
      GROUP BY r.cut_result_id`, [ids]),
  ]);
  const details = await loadPlacedDetails(db, [...new Set(placements.rows.map(p => Number(p.detail_id)))]);
  const placementsByResult = groupBy(placements.rows, p => Number(p.result_id));
  const compositionByJob = groupBy(composition.rows, c => Number(c.job_id));
  const ownersByResult = groupBy(owners.rows, o => Number(o.result_id));
  const manualByCard = new Map(manual.rows.map(row => [row.card_id, row.target_column]));
  const linkedByResult = new Map(linked.rows.map(row => [Number(row.result_id), Number(row.count)]));
  const facts = new Map<string, MdfBathSideFacts>();
  for (const row of headers.rows) {
    const cutResultId = Number(row.result_id);
    const cutJobId = Number(row.job_id);
    const bathCardId = bathCardIdOf(cutResultId);
    facts.set(bathCardId, {
      bathCardId, cutResultId, cutJobId,
      resultNo: Number(row.result_no), revisionNo: Number(row.revision_no), jobVersion: Number(row.version),
      jobName: row.job_name, sourceDisplayNumber: row.source_display_number,
      placements: (placementsByResult.get(cutResultId) ?? []).map(p => {
        const detail = details.get(Number(p.detail_id));
        return {
          orderId: Number(p.order_id), detailId: Number(p.detail_id),
          detailNumber: detail?.detail_number === null || detail?.detail_number === undefined ? null : Number(detail.detail_number),
          quantity: Number(p.quantity), laminatedOrLater: detail?.laminated_or_later === true,
          productionRound: Number(detail?.production_round ?? 1),
        };
      }),
      ownerOrderIds: (ownersByResult.get(cutResultId) ?? []).map(o => Number(o.order_id)).sort((a, b) => a - b),
      composition: (compositionByJob.get(cutJobId) ?? []).map(c => ({
        orderId: Number(c.order_id), detailId: c.detail_id === null ? null : Number(c.detail_id),
        hdfDetailId: c.hdf_detail_id === null ? null : Number(c.hdf_detail_id), quantity: Number(c.quantity),
      })),
      manualColumn: manualByCard.get(bathCardId) ?? null,
      otherLinkedCards: linkedByResult.get(cutResultId) ?? 0,
    });
  }
  return facts;
}

/** Live (not deleted) details of the placements: number, «Закатан» or later, rework round. production_round
 * (migration 274) is read only where the column exists, so the read also works on a branch without it. */
async function loadPlacedDetails(db: DatabaseClient, detailIds: readonly number[]): Promise<Map<number, DetailRow>> {
  if (!detailIds.length) return new Map();
  const hasRound = (await db.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_details' AND column_name = 'production_round') AS present`))
    .rows[0]?.present === true;
  const rows = (await db.query<DetailRow>(`WITH laminated AS (
      SELECT COALESCE(MIN(ps.sort_order) FILTER (WHERE lower(trim(COALESCE(ps.production_status_code, ''))) = 'laminated'),
        MIN(ps.sort_order) FILTER (WHERE lower(trim(ps.production_status_name)) = 'закатан')) AS sort_order
      FROM production_statuses ps)
    SELECT od.detail_id::text AS detail_id, od.detail_number,
      COALESCE(status.sort_order >= laminated.sort_order, false) AS laminated_or_later,
      ${hasRound ? 'od.production_round::int' : '1'} AS production_round
    FROM order_details od
    LEFT JOIN production_statuses status ON status.production_status_id = od.production_status_id
    CROSS JOIN laminated
    WHERE od.detail_id = ANY($1::bigint[]) AND od.delete_flag = false`, [[...detailIds]])).rows;
  return new Map(rows.map(row => [Number(row.detail_id), row]));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

/** Orders of `orderIds` inside the user's backend order view scope. */
export async function loadVisibleOrderIds(db: DatabaseClient, user: CurrentUser,
  orderIds: readonly number[]): Promise<Set<number>> {
  if (!orderIds.length) return new Set();
  const params: unknown[] = [[...new Set(orderIds)]];
  const scope = appendOrderReadScopeSql(params, user, 'o');
  return new Set((await db.query<{ order_id: string }>(`SELECT o.order_id::text AS order_id FROM orders o
    WHERE o.order_id = ANY($1::bigint[]) AND ${scope.predicate}`, params)).rows.map(row => Number(row.order_id)));
}

/** Decisions touching these baths (schema-tolerant: before migration 287 there are none). */
export async function loadBathDuplicateResolutions(db: DatabaseClient,
  bathCardIds: readonly string[]): Promise<MdfBathDuplicateResolutionFact[]> {
  if (!bathCardIds.length) return [];
  const present = (await db.query<{ present: boolean }>(
    "SELECT to_regclass('mdf_bath_duplicate_resolutions') IS NOT NULL AS present")).rows[0]?.present === true;
  if (!present) return [];
  return (await db.query<{ bath_a: string; bath_b: string; target_bath: string; action: string; digest: string }>(
    `SELECT bath_a, bath_b, target_bath, action, digest FROM mdf_bath_duplicate_resolutions
      WHERE bath_a = ANY($1::text[]) OR bath_b = ANY($1::text[])`, [[...bathCardIds]])).rows
    .filter(row => row.action === 'keep_both' || row.action === 'rework_mark')
    .map(row => ({ bathA: row.bath_a, bathB: row.bath_b, targetBath: row.target_bath,
      action: row.action as MdfBathDuplicateResolutionFact['action'], digest: row.digest }));
}

/** BACKEND_MDF_BATH_DUPLICATES_READ: duplicates on the board's bath cards (off ⇒ the response has no `duplicates`). */
export const mdfBathDuplicatesReadEnabled = () => process.env.BACKEND_MDF_BATH_DUPLICATES_READ === 'true';

/**
 * Board read (§2.1): duplicates and rework marks of the shown baths. Bounded to the active baths of the jobs that
 * placed any order of the shown baths; one round of parallel plain reads.
 */
export async function loadBoardBathDuplicates(db: DatabaseClient, user: CurrentUser, input: {
  shown: ReadonlyArray<{ bathCardId: string; column: string | null; orderIds: readonly number[] }>;
  engineOwnsBoard: boolean;
}) {
  const orderIds = [...new Set(input.shown.flatMap(card => card.orderIds))];
  const active = await loadActiveBathIdsForOrders(db, orderIds);
  const facts = await loadBathSideFacts(db, active);
  const shown = input.shown.filter(card => facts.has(card.bathCardId));
  if (!shown.length) return new Map() as ReturnType<typeof buildBathDuplicates>;
  const owners = [...new Set([...facts.values()].flatMap(bathOwnerOrderIds))];
  const [visibleOrderIds, resolutions] = await Promise.all([
    loadVisibleOrderIds(db, user, owners),
    loadBathDuplicateResolutions(db, [...facts.keys()]),
  ]);
  return buildBathDuplicates({ shown, facts, resolutions, visibleOrderIds, engineOwnsBoard: input.engineOwnsBoard });
}

/** Engine `active`/`read_only` owns the MDF board (schema-tolerant: no engine state ⇒ legacy). */
export async function loadMdfEngineOwnsBoard(db: DatabaseClient): Promise<boolean> {
  const row = (await db.query<{ owns: boolean }>(`SELECT to_regclass('mdf_engine_state') IS NOT NULL
    AND EXISTS (SELECT 1 FROM mdf_engine_state WHERE singleton AND mode IN ('active','read_only')) AS owns`)).rows[0];
  return row?.owns === true;
}

/**
 * Explicit baths (hybrid board: engine cards outside the legacy read — search, focus, old cards). A requested bath is
 * answered only when the user sees every order of it (as the engine shows a card only with all its owners visible);
 * pairs exist only for an active bath and follow the board read rules (redaction, hint, decisions).
 */
export async function loadBathDuplicatesForCards(db: DatabaseClient, user: CurrentUser, bathCardIds: readonly string[]) {
  const resultIds = [...new Set(bathCardIds)].flatMap(id => {
    const match = /^cut-result:([1-9][0-9]{0,15})$/.exec(id);
    return match ? [Number(match[1])] : [];
  });
  const [requested, engineOwnsBoard] = await Promise.all([loadBathSideFacts(db, resultIds), loadMdfEngineOwnsBoard(db)]);
  const owners = [...new Set([...requested.values()].flatMap(bathOwnerOrderIds))];
  const visible = await loadVisibleOrderIds(db, user, owners);
  const shown = [...requested.values()]
    .filter(bath => resultIds.includes(bath.cutResultId))
    .filter(bath => bath.placements.length > 0 && bathOwnerOrderIds(bath).every(id => visible.has(id)))
    .map(bath => ({ bathCardId: bath.bathCardId, column: null, orderIds: [...new Set(bath.placements.map(p => p.orderId))] }));
  const result = shown.length
    ? await loadBoardBathDuplicates(db, user, { shown, engineOwnsBoard })
    : new Map() as Awaited<ReturnType<typeof loadBoardBathDuplicates>>;
  return shown.map(card => ({ bathCardId: card.bathCardId,
    ...(result.get(card.bathCardId) ?? { duplicates: [], reworkMarks: [], reworkDetailCount: 0 }) }));
}
