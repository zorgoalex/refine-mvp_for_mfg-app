-- Merge Telegram SVG packets that were first imported as a standalone SVG and
-- then imported again when the related sheet image message arrived.

BEGIN;

DROP TABLE IF EXISTS tmp_cnc_telegram_svg_packet_alias_merges;

CREATE TEMP TABLE tmp_cnc_telegram_svg_packet_alias_merges ON COMMIT DROP AS
WITH imported AS (
  SELECT
    packet.packet_id,
    packet.external_packet_key,
    packet.source_chat_id,
    packet.source_message_id,
    packet.source_thread_id,
    packet.source_version,
    packet.source_created_at,
    packet.source_updated_at,
    COALESCE(packet.source_created_at, packet.source_updated_at, packet.created_at) AS source_at,
    packet.workday,
    regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\.[^.]+$', '') AS program_key,
    lower(trim(COALESCE(packet.material_name, 'МДФ 16мм'))) AS material_key,
    packet.cut_layout_json,
    packet.sheet_image_storage_key,
    packet.sheet_image_content_type,
    packet.sheet_image_size_bytes,
    packet.payload_hash,
    packet.cutting_sequence_no,
    packet.svg_cut_job_id,
    packet.svg_cut_result_id,
    result.result_no AS svg_cut_result_no,
    item_signature.detail_signature
  FROM cnc_telegram_packets packet
  JOIN cut_job job
    ON job.cut_job_id = packet.svg_cut_job_id
  JOIN cut_result result
    ON result.cut_job_id = packet.svg_cut_job_id
   AND result.cut_result_id = packet.svg_cut_result_id
  LEFT JOIN LATERAL (
    SELECT string_agg(
      cji.order_detail_id::text || ':' || cji.order_id::text || ':' || cji.qty::text,
      ',' ORDER BY cji.order_detail_id, cji.order_id, cji.qty
    ) AS detail_signature
    FROM cut_job_item cji
    WHERE cji.cut_job_id = packet.svg_cut_job_id
  ) item_signature ON TRUE
  WHERE packet.svg_cut_import_status = 'imported'
    AND packet.svg_cut_job_id IS NOT NULL
    AND packet.svg_cut_result_id IS NOT NULL
    AND packet.cutting_sequence_no IS NOT NULL
    AND packet.cut_layout_json->>'status' = 'valid'
    AND job.source = 'api'
    AND job.selection_criteria->>'source' = 'cnc_telegram_svg'
    AND regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\.[^.]+$', '') <> ''
),
ranked_pairs AS (
  SELECT
    canonical.packet_id AS canonical_packet_id,
    duplicate.packet_id AS duplicate_packet_id,
    canonical.external_packet_key AS canonical_external_packet_key,
    duplicate.external_packet_key AS duplicate_external_packet_key,
    canonical.svg_cut_job_id AS canonical_cut_job_id,
    duplicate.svg_cut_job_id AS duplicate_cut_job_id,
    canonical.svg_cut_result_id AS canonical_cut_result_id,
    duplicate.svg_cut_result_id AS duplicate_cut_result_id,
    canonical.svg_cut_result_no AS canonical_cut_result_no,
    canonical.cutting_sequence_no AS canonical_cutting_sequence_no,
    duplicate.cutting_sequence_no AS duplicate_cutting_sequence_no,
    duplicate.source_message_id AS duplicate_source_message_id,
    duplicate.source_thread_id AS duplicate_source_thread_id,
    duplicate.source_version AS duplicate_source_version,
    duplicate.source_created_at AS duplicate_source_created_at,
    duplicate.source_updated_at AS duplicate_source_updated_at,
    duplicate.payload_hash AS duplicate_payload_hash,
    duplicate.sheet_image_storage_key AS duplicate_sheet_image_storage_key,
    duplicate.sheet_image_content_type AS duplicate_sheet_image_content_type,
    duplicate.sheet_image_size_bytes AS duplicate_sheet_image_size_bytes,
    row_number() OVER (
      PARTITION BY duplicate.packet_id
      ORDER BY
        CASE WHEN ABS(EXTRACT(EPOCH FROM (canonical.source_at - duplicate.source_at))) <= 600 THEN 0 ELSE 1 END,
        ABS(EXTRACT(EPOCH FROM (canonical.source_at - duplicate.source_at))) ASC NULLS LAST,
        canonical.cutting_sequence_no ASC,
        canonical.source_at ASC NULLS LAST,
        canonical.packet_id ASC
    ) AS rn
  FROM imported canonical
  JOIN imported duplicate
    ON duplicate.packet_id <> canonical.packet_id
   AND duplicate.source_chat_id = canonical.source_chat_id
   AND duplicate.workday = canonical.workday
   AND duplicate.program_key = canonical.program_key
   AND duplicate.material_key = canonical.material_key
   AND duplicate.cut_layout_json = canonical.cut_layout_json
   AND duplicate.detail_signature IS NOT DISTINCT FROM canonical.detail_signature
  WHERE canonical.sheet_image_storage_key IS NULL
    AND duplicate.sheet_image_storage_key IS NOT NULL
    AND canonical.cutting_sequence_no < duplicate.cutting_sequence_no
)
SELECT *
FROM ranked_pairs
WHERE rn = 1;

UPDATE cut_job_item item
SET is_active = false,
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE item.cut_job_id = merge.duplicate_cut_job_id
  AND item.is_active = true;

UPDATE cut_job job
SET status = 'archived',
    source_display_number = NULL,
    version = version + 1,
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE job.cut_job_id = merge.duplicate_cut_job_id
  AND job.status <> 'archived';

UPDATE cut_job job
SET source_display_number = merge.canonical_cutting_sequence_no::text,
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE job.cut_job_id = merge.canonical_cut_job_id
  AND job.source_display_number IS DISTINCT FROM merge.canonical_cutting_sequence_no::text;

UPDATE cnc_telegram_packets packet
SET source_message_id = COALESCE(merge.duplicate_source_message_id, packet.source_message_id),
    source_thread_id = COALESCE(merge.duplicate_source_thread_id, packet.source_thread_id),
    source_version = GREATEST(packet.source_version, merge.duplicate_source_version),
    source_created_at = COALESCE(merge.duplicate_source_created_at, packet.source_created_at),
    source_updated_at = COALESCE(merge.duplicate_source_updated_at, packet.source_updated_at),
    payload_hash = COALESCE(merge.duplicate_payload_hash, packet.payload_hash),
    sheet_image_storage_key = COALESCE(merge.duplicate_sheet_image_storage_key, packet.sheet_image_storage_key),
    sheet_image_content_type = COALESCE(merge.duplicate_sheet_image_content_type, packet.sheet_image_content_type),
    sheet_image_size_bytes = COALESCE(merge.duplicate_sheet_image_size_bytes, packet.sheet_image_size_bytes),
    svg_cut_import_note = 'Telegram SVG packet merged with related sheet image packet',
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE packet.packet_id = merge.canonical_packet_id;

UPDATE cnc_telegram_packets packet
SET cutting_sequence_no = NULL,
    svg_cut_job_id = merge.canonical_cut_job_id,
    svg_cut_result_id = merge.canonical_cut_result_id,
    svg_cut_import_note = 'Duplicate Telegram SVG/image packet merged into cutting sequence '
      || merge.canonical_cutting_sequence_no::text,
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE packet.packet_id = merge.duplicate_packet_id;

UPDATE cnc_telegram_worker_message_logs log
SET packet_id = merge.canonical_packet_id,
    cut_job_id = merge.canonical_cut_job_id,
    cut_result_no = merge.canonical_cut_result_no,
    cutting_sequence_no = merge.canonical_cutting_sequence_no,
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE log.packet_id = merge.duplicate_packet_id;

UPDATE cnc_telegram_worker_operations operation
SET packet_id = merge.canonical_packet_id,
    cut_job_id = merge.canonical_cut_job_id,
    cut_result_no = merge.canonical_cut_result_no,
    cutting_sequence_no = merge.canonical_cutting_sequence_no,
    updated_at = now()
FROM tmp_cnc_telegram_svg_packet_alias_merges merge
WHERE operation.packet_id = merge.duplicate_packet_id;

COMMIT;
