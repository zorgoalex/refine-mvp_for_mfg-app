/**
 * Shared MDF-bath target matching. Keep cut-list card presence and the actual
 * board projection on one SQL contract.
 *
 * Expects `$1 = dateFrom`, `$2 = dateTo`.
 */
export function cncMdfTargetDetailsCtes(
  mode: 'workday-visible' | 'created-history' | 'current-visible' = 'workday-visible',
  namespace = '',
): string {
  const packetDatePredicate = mode === 'created-history'
    ? `COALESCE(p.source_created_at, p.created_at) >= $1::date
        AND COALESCE(p.source_created_at, p.created_at) < ($2::date + INTERVAL '1 day')`
    : mode === 'current-visible'
    ? 'p.workday = CURRENT_DATE'
    : 'p.workday BETWEEN $1::date AND $2::date';
  const packetVisibilityPredicate = mode === 'created-history'
    ? ''
    : 'AND p.mdf_board_hidden_at IS NULL';
  const cte = (name: string) => `${namespace}${name}`;
  return `
    ${cte('packet_items')} AS (
      SELECT
        p.workday,
        p.completion_status,
        p.thumbs_up,
        NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(p.comments_json) AS packet_comment(comment_text)
          WHERE lower(packet_comment.comment_text) LIKE ANY (
            ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']
          )
        ) AS mdf_relevant,
        i.match_order_id,
        i.match_detail_id,
        i.source,
        lower(trim(i.order_name)) AS order_key,
        i.detail_number,
        i.width_mm,
        i.height_mm,
        i.quantity
      FROM cnc_telegram_packets p
      JOIN cnc_telegram_packet_items i ON i.packet_id = p.packet_id
      WHERE ${packetDatePredicate}
        ${packetVisibilityPredicate}
    ),
    ${cte('matched_target_detail_sources')} AS (
      SELECT
        item.workday,
        item.match_order_id::bigint AS order_id,
        item.match_detail_id::bigint AS detail_id,
        SUM(
          CASE
            WHEN item.mdf_relevant
              AND (item.completion_status = 'completed' OR item.thumbs_up = true)
              THEN GREATEST(item.quantity, 0)
            ELSE 0
          END
        )::integer AS completed_quantity
      FROM ${cte('packet_items')} item
      WHERE item.match_order_id IS NOT NULL
        AND item.match_detail_id IS NOT NULL
      GROUP BY item.workday, item.match_order_id, item.match_detail_id
    ),
    ${cte('unique_order_keys')} AS (
      SELECT
        lower(trim(o.order_name)) AS order_key,
        MIN(o.order_id)::bigint AS order_id
      FROM orders o
      WHERE o.delete_flag = false
        AND NULLIF(trim(o.order_name), '') IS NOT NULL
      GROUP BY lower(trim(o.order_name))
      HAVING COUNT(*) = 1
    ),
    ${cte('completed_whole_order_keys')} AS (
      SELECT DISTINCT
        p.workday,
        whole_order.order_key
      FROM cnc_telegram_packets p
      JOIN cnc_telegram_packet_whole_order_keys whole_order
        ON whole_order.packet_id = p.packet_id
      WHERE ${packetDatePredicate}
        ${packetVisibilityPredicate}
        AND (p.completion_status = 'completed' OR p.thumbs_up = true)
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(p.comments_json) AS material_comment(comment_text)
          WHERE lower(material_comment.comment_text) LIKE ANY (
            ARRAY['%hdf%', '%хдф%', '%лдсп%', '%ldsp%', '%fanera%', '%фанера%']
          )
        )
    ),
    ${cte('whole_order_target_detail_sources')} AS (
      SELECT
        whole_order.workday,
        order_key.order_id,
        od.detail_id::bigint AS detail_id,
        1000000000::integer AS completed_quantity
      FROM ${cte('completed_whole_order_keys')} whole_order
      JOIN ${cte('unique_order_keys')} order_key
        ON order_key.order_key = whole_order.order_key
      JOIN order_details od
        ON od.order_id = order_key.order_id
       AND od.delete_flag = false
    ),
    ${cte('fallback_target_detail_sources')} AS (
      SELECT
        item.workday,
        order_key.order_id,
        od.detail_id::bigint AS detail_id,
        SUM(
          CASE
            WHEN item.mdf_relevant
              AND (item.completion_status = 'completed' OR item.thumbs_up = true)
              THEN GREATEST(item.quantity, 0)
            ELSE 0
          END
        )::integer AS completed_quantity
      FROM ${cte('packet_items')} item
      JOIN ${cte('unique_order_keys')} order_key
        ON order_key.order_key = item.order_key
      JOIN order_details od
        ON od.order_id = order_key.order_id
       AND od.delete_flag = false
      WHERE item.match_order_id IS NULL
        AND item.match_detail_id IS NULL
        AND item.detail_number IS NOT NULL
        AND od.detail_number = item.detail_number
        AND item.width_mm IS NOT NULL
        AND item.height_mm IS NOT NULL
        AND od.width IS NOT NULL
        AND od.height IS NOT NULL
        AND (
          (
            item.source <> 'ocr'
            AND (
              (item.width_mm::numeric = od.width::numeric AND item.height_mm::numeric = od.height::numeric)
              OR (item.width_mm::numeric = od.height::numeric AND item.height_mm::numeric = od.width::numeric)
            )
          )
          OR (
            item.source = 'ocr'
            AND (
              (ABS(item.width_mm::numeric - od.width::numeric) <= 3 AND ABS(item.height_mm::numeric - od.height::numeric) <= 3)
              OR (ABS(item.width_mm::numeric - od.height::numeric) <= 3 AND ABS(item.height_mm::numeric - od.width::numeric) <= 3)
            )
          )
        )
      GROUP BY item.workday, order_key.order_id, od.detail_id
    ),
    ${cte('target_detail_sources')} AS (
      SELECT * FROM ${cte('matched_target_detail_sources')}
      UNION ALL
      SELECT * FROM ${cte('fallback_target_detail_sources')}
      UNION ALL
      SELECT * FROM ${cte('whole_order_target_detail_sources')}
    ),
    ${cte('target_details')} AS (
      SELECT
        target.order_id,
        target.detail_id,
        LEAST(SUM(target.completed_quantity), 1000000000::bigint)::integer AS completed_quantity
      FROM ${cte('target_detail_sources')} target
      GROUP BY target.order_id, target.detail_id
    )`;
}
