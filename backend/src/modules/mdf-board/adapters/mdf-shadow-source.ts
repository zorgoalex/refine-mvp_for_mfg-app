import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { cncPacketCountsForMdfReadinessSql, CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE as MDF,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE as OTHER } from '../../../shared/cnc-material';
import type { MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';

export interface MdfShadowRow extends QueryResultRow {
  line_key: string | null; order_id: string | null; detail_id: string | null;
  quantity: string | null; relevant: boolean; cut: boolean; laminated: boolean;
  rework: boolean; unresolved: boolean; whole_order: boolean; stamp: string;
}
const manual = `LEFT JOIN mdf_board_manual_moves move ON move.card_kind=$1 AND move.card_id=$2`;
const material = (value: string) => `(COALESCE(${value},'') ~* '${MDF}' AND COALESCE(${value},'') !~* '${OTHER}')`;

/** Bounded by one exact source, never visibility/date or snapshot_job. Strict
 * linked identities only. Unknown identities are diagnostics, not guessed facts.
 * No production/order status is a physical manufacturing signal. */
export async function loadMdfShadowSource(tx: DatabaseClient, source: MdfBoardSource, rowLimit?: number): Promise<MdfShadowRow[]> {
  const sql = source.kind === 'packet' ? `
    SELECT i.source_item_key AS line_key,d.order_id::text,d.detail_id::text,i.quantity::text,
      ${cncPacketCountsForMdfReadinessSql('p')} AND COALESCE(p.mdf_board_card_kind,'machine_file')='machine_file' AS relevant,
      ((NOT COALESCE(p.mdf_completion_returned,false) AND (p.completion_status='completed' OR p.thumbs_up))
        OR COALESCE(move.target_column IN ('completed','completed_laminated'),false)) AS cut,
      false AS laminated,p.rework,
      (i.packet_item_id IS NOT NULL AND (d.detail_id IS NULL OR o.order_id IS NULL OR i.match_status<>'matched')) AS unresolved,
      EXISTS(SELECT 1 FROM cnc_telegram_packet_whole_order_keys k WHERE k.packet_id=p.packet_id) AS whole_order,
      concat_ws(':',p.source_version,p.updated_at,move.move_id,move.version,move.updated_at) AS stamp
    FROM cnc_telegram_packets p ${manual}
    LEFT JOIN cnc_telegram_packet_items i ON i.packet_id=p.packet_id
    LEFT JOIN order_details d ON d.detail_id=i.match_detail_id AND d.order_id=i.match_order_id AND NOT d.delete_flag
    LEFT JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag
    WHERE p.packet_id=$2::uuid ORDER BY i.source_item_key
  ` : source.kind === 'bazisCutSet' ? `
    SELECT i.bazis_cut_set_detail_id::text AS line_key,d.order_id::text,d.detail_id::text,i.quantity::text,
      ${material('i.material_name')} AND i.cut_enabled AS relevant,
      COALESCE(move.target_column IN ('completed','completed_laminated'),false) AS cut,
      false AS laminated,false AS rework,
      i.bazis_cut_set_detail_id IS NOT NULL AND (d.detail_id IS NULL OR o.order_id IS NULL) AS unresolved,
      false AS whole_order,concat_ws(':',s.version,s.updated_at,i.updated_at,move.move_id,move.version,move.updated_at) AS stamp
    FROM bazis_cut_sets s ${manual}
    LEFT JOIN bazis_cut_set_details i ON i.bazis_cut_set_id=s.bazis_cut_set_id
    LEFT JOIN order_details d ON d.detail_id=i.source_order_detail_id
      AND (i.source_order_id IS NULL OR d.order_id=i.source_order_id) AND NOT d.delete_flag
    LEFT JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag
    WHERE s.bazis_cut_set_id=$2::bigint ORDER BY i.bazis_cut_set_detail_id
  ` : `
    SELECT concat_ws(':',p.order_id,p.order_detail_id) AS line_key,
      d.order_id::text,d.detail_id::text,COUNT(*) FILTER(WHERE p.cut_result_id IS NOT NULL)::text AS quantity,
      ${material('COALESCE(smt.name,m.material_name)')} AND COALESCE(b.is_vacuum,false) AS relevant,
      false AS cut,COALESCE(move.target_column IN ('baths_laminated','completed_baths'),false) AS laminated,
      false AS rework,(d.detail_id IS NULL OR o.order_id IS NULL OR b.cut_result_id IS NULL) AS unresolved,
      false AS whole_order,concat_ws(':',r.snapshot_digest,move.move_id,move.version,move.updated_at) AS stamp
    FROM cut_result r ${manual}
    LEFT JOIN cut_result_board_projection b ON b.cut_result_id=r.cut_result_id AND b.snapshot_digest=r.snapshot_digest
    LEFT JOIN (cut_result_placement p JOIN cut_result_sheet_map sheet
      ON sheet.cut_result_sheet_map_id=p.cut_result_sheet_map_id AND sheet.is_effective)
      ON p.cut_result_id=r.cut_result_id
    LEFT JOIN order_details d ON d.detail_id=p.order_detail_id AND d.order_id=p.order_id AND NOT d.delete_flag
    LEFT JOIN orders o ON o.order_id=d.order_id AND NOT o.delete_flag
    LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id=d.sheet_material_type_id
    LEFT JOIN materials m ON m.material_id=d.material_id
    WHERE r.cut_result_id=split_part($2,':',2)::bigint
      AND p.order_hdf_detail_id IS NULL
    GROUP BY p.order_id,p.order_detail_id,d.order_id,d.detail_id,o.order_id,b.cut_result_id,b.is_vacuum,
      smt.name,m.material_name,r.snapshot_digest,move.move_id,move.version,move.updated_at,move.target_column
    ORDER BY p.order_id,p.order_detail_id
  `;
  return (await tx.query<MdfShadowRow>(rowLimit === undefined ? sql : `SELECT * FROM (${sql}) bounded LIMIT $3`,
    rowLimit === undefined ? [source.kind, source.id] : [source.kind, source.id, rowLimit])).rows;
}
