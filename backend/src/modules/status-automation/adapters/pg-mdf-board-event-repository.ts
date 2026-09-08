import type { QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import { mdfCutReadinessCtes } from '../../../shared/cnc-material/cut-readiness-sql';
import { CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE, CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE } from '../../../shared/cnc-material';
import type { MdfBoardResolvedEvent, MdfBoardSource } from '../application/mdf-board-event.types';

interface FactRow extends QueryResultRow {
  kind: MdfBoardSource['kind']; card_id: string; event_type: MdfBoardResolvedEvent['eventType'];
  order_id: string | number; detail_id: string | number;
  required_quantity: string | number; eligible_quantity: string | number;
}

/** Command-side read model: no UI dates/filters, no snapshot_job reads, no writes to source facts. */
export async function loadMdfBoardEvents(
  tx: TransactionClient, source: MdfBoardSource,
): Promise<MdfBoardResolvedEvent[]> {
  if (!validSource(source)) return [];
  // Resolve ownership on the server. Include mixed-order baths before locking,
  // otherwise a split bath could never observe completion of its other orders.
  const owners = await tx.query<{ order_id: string | number }>(`
    WITH named_owners AS (
      SELECT lower(trim(order_name)) AS name, MIN(order_id) AS order_id FROM orders
      WHERE delete_flag = false AND order_kind = 'production_order'
      GROUP BY lower(trim(order_name)) HAVING COUNT(*) = 1
    ), source_orders AS (
      SELECT COALESCE(i.match_order_id, n.order_id) AS order_id
      FROM cnc_telegram_packet_items i LEFT JOIN named_owners n ON n.name = lower(trim(i.order_name))
      WHERE $1 = 'packet' AND i.packet_id::text = $2
      UNION SELECT COALESCE(i.source_order_id, d.order_id)
      FROM bazis_cut_set_details i LEFT JOIN order_details d ON d.detail_id = i.source_order_detail_id
      WHERE $1 = 'bazisCutSet' AND i.bazis_cut_set_id::text = $2
      UNION SELECT p.order_id FROM cut_result_placement p
      WHERE $1 = 'bath' AND ('cut-result:' || p.cut_result_id::text) = $2
    ), related_orders AS (
      SELECT order_id FROM source_orders
      UNION SELECT sibling.order_id FROM cut_result_placement sibling
      JOIN cut_result_placement member ON member.cut_result_id = sibling.cut_result_id
      JOIN source_orders owner ON owner.order_id = member.order_id
    )
    SELECT o.order_id FROM orders o JOIN related_orders r ON r.order_id = o.order_id
    WHERE o.delete_flag = false AND o.order_kind = 'production_order'
    ORDER BY o.order_id FOR UPDATE OF o
  `, [source.kind, source.id]);
  const orderIds = owners.rows.map(r => Number(r.order_id));
  if (!orderIds.length) return [];
  const result = await tx.query<FactRow>(`
    WITH target_details AS (
      SELECT order_id, detail_id AS order_detail_id FROM order_details
      WHERE order_id = ANY($3::bigint[]) AND delete_flag = false
    ), ${mdfCutReadinessCtes({ targetDetails: 'target_details' })},
    allocated_quantities AS (
      SELECT order_id, detail_id, SUM(quantity) AS quantity FROM (
        SELECT i.order_id, i.detail_id, i.quantity FROM mdf_resolved_packet_items i
        JOIN mdf_source_packets p USING(packet_id) WHERE p.mdf_relevant AND i.detail_id IS NOT NULL
        UNION ALL SELECT order_id, detail_id, quantity FROM mdf_bazis_items WHERE mdf_relevant
      ) q GROUP BY order_id, detail_id
    ), machine_members AS (
      SELECT 'packet'::text AS kind, p.packet_id::text AS card_id, i.order_id, i.detail_id,
        p.visually_cut AS cut FROM mdf_packet_columns p
      JOIN mdf_resolved_packet_items i USING(packet_id)
      WHERE p.mdf_relevant AND i.detail_id IS NOT NULL AND i.quantity > 0
      UNION ALL
      SELECT 'bazisCutSet', i.bazis_cut_set_id::text, i.order_id, i.detail_id, c.visually_cut
      FROM mdf_bazis_items i JOIN mdf_bazis_columns c USING(bazis_cut_set_id)
      WHERE i.mdf_relevant AND i.quantity > 0
    ), direct_machine_details AS (
      SELECT DISTINCT order_id, detail_id FROM machine_members WHERE kind = $1 AND card_id = $2
    ), latest_baths AS (
      SELECT DISTINCT ON (j.cut_job_id) r.cut_result_id, j.cut_job_id
      FROM cut_job j JOIN cut_result r ON r.cut_job_id = j.cut_job_id
      JOIN cut_result_board_projection b ON b.cut_result_id = r.cut_result_id AND b.snapshot_digest = r.snapshot_digest
      JOIN cut_result_label_map_projection projection
        ON projection.cut_result_id = r.cut_result_id AND projection.snapshot_digest = r.snapshot_digest
      LEFT JOIN cut_result current_result ON current_result.cut_result_id = j.current_cut_result_id
      LEFT JOIN cut_result_archive_state archive ON archive.cut_job_id = r.cut_job_id AND archive.result_no = r.result_no
      WHERE b.is_vacuum = true AND j.status <> 'archived' AND archive.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM cnc_telegram_packets tombstone
          WHERE tombstone.svg_cut_result_id = r.cut_result_id AND tombstone.mdf_board_card_kind = 'bath_seed'
            AND tombstone.mdf_board_hidden_at IS NOT NULL)
      ORDER BY j.cut_job_id, (current_result.result_no = r.result_no) DESC,
        r.created_at DESC, r.result_no DESC, r.revision_no DESC, r.cut_result_id DESC
    ), bath_members AS (
      SELECT b.cut_result_id, p.order_id, p.order_detail_id AS detail_id,
        COUNT(*) AS quantity,
        BOOL_AND(COALESCE(d.detail_id IS NOT NULL AND o.order_id IS NOT NULL, false)) AS resolved,
        COALESCE(c.completed_quantity, 0) AS cut_quantity,
        COALESCE(s.sort_order >= (SELECT MIN(sort_order) FROM production_statuses
          WHERE lower(production_status_code) = 'laminated'), false) AS laminated,
        COALESCE(s.sort_order >= (SELECT packed FROM mdf_cut_thresholds), false) AS packed,
        COALESCE((COALESCE(smt.name, material.material_name, '') ~* '${CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE}'
          OR allocated.quantity > 0)
          AND COALESCE(smt.name, material.material_name, '') !~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}', false) AS mdf_relevant
      FROM latest_baths b JOIN cut_result_placement p ON p.cut_result_id = b.cut_result_id
      JOIN cut_result_sheet_map sheet ON sheet.cut_result_sheet_map_id = p.cut_result_sheet_map_id
        AND sheet.is_effective = true
      LEFT JOIN order_details d ON d.detail_id = p.order_detail_id AND d.order_id = p.order_id AND d.delete_flag = false
      LEFT JOIN orders o ON o.order_id = d.order_id AND o.delete_flag = false AND o.order_kind = 'production_order'
      LEFT JOIN production_statuses s ON s.production_status_id = d.production_status_id
      LEFT JOIN materials material ON material.material_id = d.material_id
      LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = d.sheet_material_type_id
      LEFT JOIN mdf_cut_quantities c ON c.order_id = p.order_id AND c.detail_id = p.order_detail_id
      LEFT JOIN allocated_quantities allocated ON allocated.order_id = p.order_id AND allocated.detail_id = p.order_detail_id
      GROUP BY b.cut_result_id, p.order_id, p.order_detail_id, c.completed_quantity,
        s.sort_order, smt.name, material.material_name, allocated.quantity
    ), bath_states AS (
      SELECT m.cut_result_id,
        CASE WHEN BOOL_AND(m.resolved AND m.packed) THEN 'completed_baths'
          WHEN MIN(move.target_column) IS NOT NULL THEN MIN(move.target_column)
          WHEN BOOL_AND(m.resolved AND m.cut_quantity >= m.quantity) AND BOOL_AND(m.laminated) THEN 'baths_laminated'
          WHEN BOOL_AND(m.resolved AND m.cut_quantity >= m.quantity) THEN 'baths_ready'
          ELSE 'baths' END AS column_key
      FROM bath_members m LEFT JOIN mdf_board_manual_moves move
        ON move.card_kind = 'bath' AND move.card_id = ('cut-result:' || m.cut_result_id::text)
      GROUP BY m.cut_result_id
    ), bath_totals AS (
      SELECT m.order_id, m.detail_id, SUM(m.quantity) AS present_quantity,
        SUM(CASE WHEN s.column_key IN ('baths_ready','baths_laminated','completed_baths') THEN m.quantity ELSE 0 END) AS ready_quantity,
        SUM(CASE WHEN s.column_key IN ('baths_laminated','completed_baths') THEN m.quantity ELSE 0 END) AS laminated_quantity
      FROM bath_members m JOIN bath_states s USING(cut_result_id)
      WHERE m.resolved AND m.mdf_relevant GROUP BY m.order_id, m.detail_id
    ), events AS (
      SELECT DISTINCT m.kind, m.card_id, m.order_id, m.detail_id,
        CASE WHEN m.cut THEN 'mdf.board.completed' ELSE 'mdf.order_machine_files_present' END AS event_type,
        CASE WHEN m.cut THEN COALESCE(c.completed_quantity,0) ELSE COALESCE(a.quantity,0) END AS eligible_quantity
      FROM machine_members m
      LEFT JOIN mdf_cut_quantities c ON c.order_id=m.order_id AND c.detail_id=m.detail_id
      LEFT JOIN allocated_quantities a ON a.order_id=m.order_id AND a.detail_id=m.detail_id
      WHERE m.kind=$1 AND m.card_id=$2
      UNION ALL
      SELECT 'bath', 'cut-result:' || m.cut_result_id::text, m.order_id, m.detail_id,
        CASE WHEN s.column_key IN ('baths_laminated','completed_baths') THEN 'mdf.board.baths_laminated'
          WHEN s.column_key='baths_ready' THEN 'mdf.board.baths_ready' ELSE 'mdf.board.baths' END,
        CASE WHEN s.column_key IN ('baths_laminated','completed_baths') THEN total.laminated_quantity
          WHEN s.column_key='baths_ready' THEN total.ready_quantity ELSE total.present_quantity END
      FROM bath_members m JOIN bath_states s USING(cut_result_id)
      JOIN bath_totals total ON total.order_id=m.order_id AND total.detail_id=m.detail_id
      WHERE m.resolved AND m.mdf_relevant AND (
        ($1='bath' AND ('cut-result:' || m.cut_result_id::text)=$2)
        OR ($1 IN ('packet','bazisCutSet') AND EXISTS (
          SELECT 1 FROM bath_members member JOIN direct_machine_details direct
            ON direct.order_id=member.order_id AND direct.detail_id=member.detail_id
          WHERE member.cut_result_id=m.cut_result_id))
      )
    )
    SELECT e.*, GREATEST(COALESCE(d.quantity,1),1) AS required_quantity
    FROM events e JOIN order_details d ON d.detail_id=e.detail_id AND d.order_id=e.order_id
    WHERE d.delete_flag=false
    ORDER BY e.kind, e.card_id, e.order_id, e.detail_id
  `, [source.kind, source.id, orderIds]);
  const events = new Map<string, MdfBoardResolvedEvent>();
  for (const row of result.rows) {
    const orderId = Number(row.order_id), detailId = Number(row.detail_id);
    const key = `${row.kind}:${row.card_id}:${row.event_type}:${orderId}`;
    let event = events.get(key);
    if (!event) {
      event = { eventType: row.event_type, orderId, scope: { source: { kind: row.kind, id: row.card_id }, details: [] } };
      events.set(key, event);
    }
    if (!event.scope.details.some(d => d.detailId === detailId)) event.scope.details.push({
      detailId, requiredQuantity: Number(row.required_quantity), eligibleQuantity: Number(row.eligible_quantity),
    });
  }
  return [...events.values()];
}

function validSource(source: MdfBoardSource): boolean {
  if (!source || typeof source.id !== 'string') return false;
  if (source.kind === 'packet') return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.id);
  if (source.kind === 'bazisCutSet') return /^[1-9]\d*$/.test(source.id);
  return source.kind === 'bath' && /^cut-result:[1-9]\d*$/.test(source.id);
}
