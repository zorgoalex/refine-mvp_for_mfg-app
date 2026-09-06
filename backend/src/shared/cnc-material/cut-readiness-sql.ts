import { cncPacketCountsForMdfReadinessSql, CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE,
  CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE } from './index';

interface CutReadinessScope {
  /** Internal SQL predicates only; never interpolate request text. */
  packetPredicate?: string;
  bazisPredicate?: string;
  targetDetails?: 'target_details' | 'result_details';
}

/** Shared bath cut quantities. Full source membership precedes target filtering. */
export function mdfCutReadinessCtes(scope: CutReadinessScope = {}): string {
  const packetTarget = scope.targetDetails ? `AND (
    EXISTS (SELECT 1 FROM cnc_telegram_packet_items scoped_item
      JOIN ${scope.targetDetails} target ON target.order_detail_id = scoped_item.match_detail_id
      WHERE scoped_item.packet_id = p.packet_id)
    OR EXISTS (SELECT 1 FROM cnc_telegram_packet_items scoped_item
      JOIN ${scope.targetDetails} target ON target.order_id = scoped_item.match_order_id
      WHERE scoped_item.packet_id = p.packet_id)
    OR EXISTS (SELECT 1 FROM cnc_telegram_packet_items scoped_item
      JOIN mdf_unique_order_keys owner ON owner.order_key = lower(trim(scoped_item.order_name))
      JOIN ${scope.targetDetails} target ON target.order_id = owner.order_id
      WHERE scoped_item.packet_id = p.packet_id)
    OR EXISTS (SELECT 1 FROM cnc_telegram_packet_whole_order_keys whole_order
      JOIN mdf_unique_order_keys owner ON owner.order_key = whole_order.order_key
      JOIN ${scope.targetDetails} target ON target.order_id = owner.order_id
      WHERE whole_order.packet_id = p.packet_id)
  )` : '';
  const basisTarget = scope.targetDetails ? `AND EXISTS (
    SELECT 1 FROM bazis_cut_set_details scoped_item
    JOIN ${scope.targetDetails} target ON target.order_detail_id = scoped_item.source_order_detail_id
    WHERE scoped_item.bazis_cut_set_id = cut_set.bazis_cut_set_id
  )` : '';
  const idsContain = (array: string, id: string) => `EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${array}) = 'array'
      THEN ${array} ELSE '[]'::jsonb END) configured(id)
    WHERE configured.id = ${id}::text
  )`;
  return `
    mdf_cut_thresholds AS (
      SELECT
        COALESCE(MIN(sort_order) FILTER (WHERE lower(trim(production_status_code)) = 'packed'),
          MIN(sort_order) FILTER (WHERE lower(trim(production_status_name)) = 'упакован')) AS packed,
        COALESCE(MIN(sort_order) FILTER (WHERE lower(trim(production_status_code)) = 'issued'),
          MIN(sort_order) FILTER (WHERE lower(trim(production_status_name)) = 'выдан')) AS issued,
        (SELECT MIN(sort_order) FROM order_statuses WHERE lower(trim(order_status_name)) = 'выдан') AS order_issued
      FROM production_statuses
    ),
    mdf_board_setting AS (
      SELECT COALESCE((SELECT value_json FROM app_settings
        WHERE setting_key = 'status_automation.mdf_board_hidden_production_statuses'
          AND is_active = true), '{}'::jsonb) AS value
    ),
    mdf_unique_order_keys AS (
      SELECT lower(trim(order_name)) AS order_key, MIN(order_id)::bigint AS order_id
      FROM orders WHERE delete_flag = false AND order_kind = 'production_order'
        AND NULLIF(trim(order_name), '') IS NOT NULL
      GROUP BY lower(trim(order_name)) HAVING COUNT(*) = 1
    ),
    mdf_source_packets AS MATERIALIZED (
      SELECT p.packet_id, p.completion_status, p.thumbs_up,
        ${cncPacketCountsForMdfReadinessSql('p')}
          AND NOT COALESCE(p.rework, false)
          AND COALESCE(p.mdf_board_card_kind, 'machine_file') = 'machine_file'
          AND (p.source_chat_id IS DISTINCT FROM 'erp-manual-svg-upload' OR EXISTS (
            SELECT 1 FROM outbox_events manual_svg_mdf_card
            WHERE manual_svg_mdf_card.idempotency_key = 'cnc-manual-svg:' || p.packet_id::text
              || ':source-' || p.source_version::text || ':mdf-card-created'
          )) AS mdf_relevant,
        move.target_column AS manual_column
      FROM cnc_telegram_packets p
      LEFT JOIN mdf_board_manual_moves move ON move.card_kind = 'packet' AND move.card_id = p.packet_id::text
      WHERE ${scope.packetPredicate ?? 'p.mdf_board_hidden_at IS NULL'} ${packetTarget}
    ),
    mdf_resolved_packet_items AS MATERIALIZED (
      SELECT packet.packet_id, i.packet_id IS NOT NULL AS has_item,
        COALESCE(matched.detail_id, inferred.detail_id) AS detail_id,
        COALESCE(matched.order_id, inferred.order_id) AS order_id,
        GREATEST(COALESCE(i.quantity, 0), 0) AS quantity,
        status.sort_order AS status_sort_order
      FROM mdf_source_packets packet
      LEFT JOIN cnc_telegram_packet_items i ON i.packet_id = packet.packet_id
      LEFT JOIN orders matched_owner ON matched_owner.order_id = i.match_order_id AND matched_owner.delete_flag = false
      LEFT JOIN mdf_unique_order_keys named_owner ON named_owner.order_key = lower(trim(i.order_name))
      LEFT JOIN order_details matched ON matched.detail_id = i.match_detail_id
        AND matched.order_id = matched_owner.order_id AND matched.delete_flag = false
      LEFT JOIN LATERAL (
        SELECT MIN(candidate.detail_id)::bigint AS detail_id, MIN(candidate.order_id)::bigint AS order_id,
          MIN(candidate.production_status_id)::bigint AS production_status_id
        FROM order_details candidate
        WHERE candidate.order_id = COALESCE(matched_owner.order_id, named_owner.order_id)
          AND candidate.delete_flag = false AND candidate.detail_number = i.detail_number
          AND i.width_mm IS NOT NULL AND i.height_mm IS NOT NULL
          AND candidate.width IS NOT NULL AND candidate.height IS NOT NULL
          AND ((i.source <> 'ocr' AND (
              (i.width_mm::numeric = candidate.width::numeric AND i.height_mm::numeric = candidate.height::numeric)
              OR (i.width_mm::numeric = candidate.height::numeric AND i.height_mm::numeric = candidate.width::numeric)))
            OR (i.source = 'ocr' AND (
              (ABS(i.width_mm::numeric - candidate.width::numeric) <= 3 AND ABS(i.height_mm::numeric - candidate.height::numeric) <= 3)
              OR (ABS(i.width_mm::numeric - candidate.height::numeric) <= 3 AND ABS(i.height_mm::numeric - candidate.width::numeric) <= 3))))
        HAVING COUNT(*) = 1
      ) inferred ON matched.detail_id IS NULL
      LEFT JOIN production_statuses status
        ON status.production_status_id = COALESCE(matched.production_status_id, inferred.production_status_id)
    ),
    mdf_packet_status AS (
      SELECT item.packet_id,
        BOOL_AND(COALESCE(item.has_item AND item.detail_id IS NOT NULL AND item.status_sort_order >= threshold.packed, false)) AS all_packed,
        BOOL_AND(COALESCE(item.has_item AND item.detail_id IS NOT NULL AND item.status_sort_order >= threshold.issued, false)) AS all_issued
      FROM mdf_resolved_packet_items item CROSS JOIN mdf_cut_thresholds threshold GROUP BY item.packet_id
    ),
    mdf_packet_columns AS (
      SELECT packet.*,
        CASE
          WHEN (packet.completion_status = 'completed' OR packet.thumbs_up = true) AND status.all_packed THEN true
          WHEN NOT COALESCE(packet.completion_status = 'completed' OR packet.thumbs_up = true, false)
            AND COALESCE(packet.manual_column, 'parsed') = 'parsed' AND status.all_issued THEN true
          WHEN packet.manual_column IS NOT NULL THEN packet.manual_column IN ('completed', 'completed_laminated')
          ELSE COALESCE(packet.completion_status = 'completed' OR packet.thumbs_up = true, false)
        END AS visually_cut
      FROM mdf_source_packets packet JOIN mdf_packet_status status USING (packet_id)
    ),
    completed_whole_order_keys AS (
      SELECT DISTINCT whole_order.order_key
      FROM mdf_source_packets packet
      JOIN cnc_telegram_packet_whole_order_keys whole_order ON whole_order.packet_id = packet.packet_id
      WHERE packet.mdf_relevant AND (packet.completion_status = 'completed' OR packet.thumbs_up = true)
    ),
    whole_order_target_details AS (
      SELECT owner.order_id, detail.detail_id, 1000000000::bigint AS quantity
      FROM completed_whole_order_keys whole_order
      JOIN mdf_unique_order_keys owner ON owner.order_key = whole_order.order_key
      JOIN order_details detail ON detail.order_id = owner.order_id AND detail.delete_flag = false
    ),
    mdf_cnc_quantities AS (
      SELECT order_id, detail_id, LEAST(SUM(quantity), 1000000000::bigint)::integer AS completed_quantity
      FROM (
        SELECT item.order_id, item.detail_id,
          CASE WHEN packet.mdf_relevant AND packet.visually_cut THEN item.quantity ELSE 0 END AS quantity
        FROM mdf_resolved_packet_items item JOIN mdf_packet_columns packet USING (packet_id)
        WHERE item.detail_id IS NOT NULL
        UNION ALL SELECT * FROM whole_order_target_details
      ) source GROUP BY order_id, detail_id
    ),
    mdf_source_bazis AS (
      SELECT cut_set.bazis_cut_set_id, move.target_column AS manual_column
      FROM bazis_cut_sets cut_set
      LEFT JOIN mdf_board_manual_moves move ON move.card_kind = 'bazisCutSet' AND move.card_id = cut_set.bazis_cut_set_id::text
      WHERE ${scope.bazisPredicate ?? 'true'} ${basisTarget}
    ),
    mdf_bazis_items AS MATERIALIZED (
      SELECT source.bazis_cut_set_id, source.manual_column,
        COALESCE(item.source_order_id, detail.order_id) AS order_id,
        item.source_order_detail_id AS detail_id, GREATEST(COALESCE(item.quantity, 0), 0) AS quantity,
        detail.detail_id IS NOT NULL AND detail.delete_flag = false
          AND owner.order_id IS NOT NULL AND owner.delete_flag = false
          AND detail.order_id = owner.order_id
          AND COALESCE(item.material_name, '') ~* '${CNC_MDF_MATERIAL_MARKER_PATTERN_SOURCE}'
          AND COALESCE(item.material_name, '') !~* '${CNC_OTHER_MATERIAL_MARKER_PATTERN_SOURCE}' AS mdf_relevant,
        COALESCE(status.sort_order >= threshold.packed OR order_status.sort_order >= threshold.order_issued, false) AS packed,
        owner.order_id IS NOT NULL AND owner.delete_flag = false AND CASE
          WHEN jsonb_typeof(setting.value -> 'cardRules') = 'array' THEN
            ${idsContain(`(SELECT rule -> 'orderStatusIds' FROM jsonb_array_elements(setting.value -> 'cardRules') rule
              WHERE rule ->> 'cardKind' = 'bazisCutSet' LIMIT 1)`, 'owner.order_status_id')}
          ELSE (
            CASE WHEN jsonb_typeof(setting.value -> 'productionStatusIds') = 'array'
              THEN ${idsContain("setting.value -> 'productionStatusIds'", 'owner.production_status_id')}
              ELSE lower(trim(owner_status.production_status_name)) IN ('закатан', 'упакован', 'выдан') END
            OR CASE WHEN jsonb_typeof(setting.value -> 'orderStatusIds') = 'array'
              THEN ${idsContain("setting.value -> 'orderStatusIds'", 'owner.order_status_id')}
              ELSE order_status.sort_order >= threshold.order_issued
                OR lower(trim(order_status.order_status_name)) IN ('выдан', 'завершен', 'завершён') END
          ) END AS hidden_by_rule
      FROM mdf_source_bazis source
      JOIN bazis_cut_set_details item ON item.bazis_cut_set_id = source.bazis_cut_set_id
      LEFT JOIN order_details detail ON detail.detail_id = item.source_order_detail_id
      LEFT JOIN orders owner ON owner.order_id = COALESCE(item.source_order_id, detail.order_id)
      LEFT JOIN production_statuses status ON status.production_status_id = detail.production_status_id
      LEFT JOIN production_statuses owner_status ON owner_status.production_status_id = owner.production_status_id
      LEFT JOIN order_statuses order_status ON order_status.order_status_id = owner.order_status_id
      CROSS JOIN mdf_cut_thresholds threshold CROSS JOIN mdf_board_setting setting
    ),
    mdf_bazis_columns AS (
      SELECT bazis_cut_set_id,
        BOOL_AND(packed) OR BOOL_AND(COALESCE(hidden_by_rule, false))
          OR COALESCE(MIN(manual_column) IN ('completed', 'completed_laminated'), false) AS visually_cut
      FROM mdf_bazis_items GROUP BY bazis_cut_set_id
    ),
    mdf_bazis_quantities AS (
      SELECT item.order_id, item.detail_id,
        LEAST(SUM(CASE WHEN item.mdf_relevant AND state.visually_cut THEN item.quantity ELSE 0 END),
          1000000000::bigint)::integer AS completed_quantity
      FROM mdf_bazis_items item JOIN mdf_bazis_columns state USING (bazis_cut_set_id)
      WHERE item.order_id IS NOT NULL AND item.detail_id IS NOT NULL
      GROUP BY item.order_id, item.detail_id
    ),
    mdf_cut_quantities AS (
      SELECT order_id, detail_id, MAX(completed_quantity)::integer AS completed_quantity
      FROM (SELECT * FROM mdf_cnc_quantities UNION ALL SELECT * FROM mdf_bazis_quantities) source
      GROUP BY order_id, detail_id
    )`;
}
