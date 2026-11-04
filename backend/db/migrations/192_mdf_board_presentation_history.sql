-- §5.6 board on the coherent publication.
-- (1) Presentation binding: an accepted revision may carry a digest of the composition-sensitive raw presentation that
--     a card renders next to its accounting (items with sizes, previews, program/file names). Only receipts that
--     establish membership from raw data compute it; carrying receipts copy the predecessor's row (absent stays absent).
--     Name/version/comments/rework/thumbs-up are live annotations and never part of the digest.
-- (2) Engine history: both board-history triggers of migration 141 resolve the card subject of engine events
--     (entity '<kind>:<id>' of entity_type mdf_source / mdf_board_card) and admit mdf.order_correction.requested.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_evidence_revisions')) IS NULL
    THEN
    RAISE EXCEPTION 'MDF migration 192 requires migration 165 in schema %',current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_revision_presentation (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  presentation_digest TEXT NOT NULL CHECK (presentation_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_id, revision_key),
  FOREIGN KEY (source_kind, source_id, revision_key)
    REFERENCES mdf_evidence_revisions(source_kind, source_id, revision_key) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION mdf_reject_revision_presentation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF revision presentation bindings are immutable' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS mdf_revision_presentation_immutable ON mdf_revision_presentation;
CREATE TRIGGER mdf_revision_presentation_immutable BEFORE UPDATE OR DELETE ON mdf_revision_presentation
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_revision_presentation_change();

-- Digest of the raw composition-sensitive presentation of one source; NULL when the raw source is absent.
-- plpgsql: raw tables are resolved at call time (schemas without CNC/BASIS/cut tables can still install it).
CREATE OR REPLACE FUNCTION mdf_source_presentation_digest(p_kind TEXT, p_id TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (SELECT CASE
    WHEN p_kind = 'packet' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
          p.program_name, p.external_packet_key, p.material_name, p.sheet_image_storage_key,
          p.svg_cut_job_id, p.svg_cut_result_id, p.cut_layout_json, p.layout_fingerprint,
          COALESCE((SELECT jsonb_agg(jsonb_build_array(i.source_item_key, i.match_order_id, i.match_detail_id,
              i.detail_number, i.width_mm, i.height_mm, i.quantity) ORDER BY i.source_item_key, i.packet_item_id)
            FROM cnc_telegram_packet_items i WHERE i.packet_id = p.packet_id), '[]'::jsonb))::text, 'UTF8')), 'hex')
      FROM cnc_telegram_packets p
      WHERE p_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' AND p.packet_id = p_id::uuid)
    WHEN p_kind = 'bazisCutSet' THEN (
      SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(d.bazis_cut_set_detail_id,
          d.source_order_id, d.source_order_detail_id, d.source_order_hdf_detail_id, d.material_name, d.position,
          d.part_name, d.cut_length_mm, d.cut_width_mm, d.finished_length_mm, d.finished_width_mm, d.quantity,
          d.cut_enabled) ORDER BY d.bazis_cut_set_detail_id), '[]'::jsonb)::text, 'UTF8')), 'hex')
      FROM bazis_cut_sets s LEFT JOIN bazis_cut_set_details d ON d.bazis_cut_set_id = s.bazis_cut_set_id
      WHERE p_id ~ '^[1-9][0-9]{0,17}$' AND s.bazis_cut_set_id = p_id::bigint
      GROUP BY s.bazis_cut_set_id)
    WHEN p_kind = 'bath' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(r.cut_result_id, r.snapshot_digest)::text, 'UTF8')), 'hex')
      FROM cut_result r
      WHERE p_id ~ '^cut-result:[1-9][0-9]{0,17}$' AND r.cut_result_id = substring(p_id FROM 12)::bigint)
  END);
END;
$$;

-- The board-history triggers exist only once migration 141 is applied; redefine their functions only then.
DO $do$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_board_history_events')) IS NOT NULL THEN
    EXECUTE $fn1$
CREATE OR REPLACE FUNCTION record_mdf_board_history_from_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_subject_kind TEXT;
  resolved_subject_id TEXT;
  resolved_event_kind TEXT;
BEGIN
  IF NEW.related_order_id IS NULL OR NOT (
    NEW.event LIKE 'orders.%'
    OR NEW.event LIKE 'order.%'
    OR NEW.event LIKE 'production.%'
    OR NEW.event LIKE 'cnc.telegram_packet.%'
    OR NEW.event LIKE 'cnc.manual_svg_upload.%'
    OR NEW.event LIKE 'cut_job.%'
    OR NEW.event LIKE 'bazis_cut_set.%'
    OR NEW.event LIKE 'mdf_board.%'
    OR NEW.event LIKE 'status_automation.%'
    OR NEW.event = 'mdf.order_correction.requested'
  ) THEN
    RETURN NEW;
  END IF;

  resolved_subject_kind := CASE
    WHEN NEW.event LIKE 'cnc.telegram_packet.%' OR NEW.event LIKE 'cnc.manual_svg_upload.%' THEN 'packet'
    WHEN NEW.event LIKE 'cut_job.%' THEN 'bath'
    WHEN NEW.event LIKE 'bazis_cut_set.%' THEN 'bazisCutSet'
    WHEN NEW.event LIKE 'mdf_board.manual_move.%'
      AND split_part(COALESCE(NEW.entity_id, ''), ':', 1) IN ('order', 'packet', 'bazisCutSet', 'bath')
      THEN split_part(NEW.entity_id, ':', 1)
    -- §5.6: engine events address the card as entity '<kind>:<id>' (mdf_source / mdf_board_card).
    WHEN NEW.entity_type IN ('mdf_source', 'mdf_board_card')
      AND split_part(COALESCE(NEW.entity_id, ''), ':', 1) IN ('packet', 'bazisCutSet', 'bath')
      THEN split_part(NEW.entity_id, ':', 1)
    WHEN NEW.entity_type = 'mdf_bath' AND COALESCE(NEW.entity_id, '') ~ '^cut-result:[1-9][0-9]*$' THEN 'bath'
    ELSE 'order'
  END;
  resolved_subject_id := CASE
    WHEN NEW.event LIKE 'mdf_board.manual_move.%' AND position(':' IN COALESCE(NEW.entity_id, '')) > 0
      THEN substring(NEW.entity_id FROM position(':' IN NEW.entity_id) + 1)
    WHEN NEW.entity_type IN ('mdf_source', 'mdf_board_card')
      AND split_part(COALESCE(NEW.entity_id, ''), ':', 1) IN ('packet', 'bazisCutSet', 'bath')
      THEN substring(NEW.entity_id FROM position(':' IN NEW.entity_id) + 1)
    WHEN NEW.entity_type = 'mdf_bath' AND COALESCE(NEW.entity_id, '') ~ '^cut-result:[1-9][0-9]*$' THEN NEW.entity_id
    ELSE COALESCE(NULLIF(NEW.entity_id, ''), NEW.related_order_id::text, NEW.audit_id::text)
  END;
  resolved_event_kind := CASE
    WHEN NEW.event = 'orders.create' THEN 'not_on_board'
    WHEN NEW.event IN ('orders.delete', 'bazis_cut_set.deleted') THEN 'disappeared'
    WHEN NEW.event = 'orders.restore' THEN 'first_known'
    WHEN NEW.event LIKE 'mdf_board.manual_move.%' OR NEW.event = 'orders.status_change' THEN 'moved'
    WHEN NEW.event IN ('cut_job.calculated', 'bazis_cut_set.created', 'cnc.telegram_packet.ingested') THEN 'appeared'
    ELSE 'progress'
  END;

  INSERT INTO mdf_board_history_events (
    event_key, correlation_key, step_code, event_sequence, order_id,
    subject_kind, subject_id, display_card_kind, display_card_id, event_kind,
    reason_code, reason_context, consequence_context, actor_kind, actor_user_id,
    triggered_by_user_id, source_event_type, source_event_id, rule_version,
    provenance, evidence_refs, occurred_at
  ) VALUES (
    'audit:' || NEW.audit_id::text || ':order:' || NEW.related_order_id::text,
    COALESCE(NULLIF(NEW.request_id, ''), NEW.audit_id::text),
    NEW.event,
    0,
    NEW.related_order_id,
    resolved_subject_kind,
    resolved_subject_id,
    resolved_subject_kind,
    resolved_subject_id,
    resolved_event_kind,
    upper(regexp_replace(NEW.event, '[^A-Za-z0-9]+', '_', 'g')),
    jsonb_build_object(
      'event', NEW.event,
      'statusName', NEW.status_name,
      'statusCode', NEW.status_code,
      'before', COALESCE(NEW.before_json, '{}'::jsonb),
      'after', COALESCE(NEW.after_json, '{}'::jsonb),
      'diff', COALESCE(NEW.diff_json, '{}'::jsonb)
    ),
    COALESCE(NEW.metadata_json, '{}'::jsonb),
    CASE WHEN NEW.user_id IS NULL THEN 'system' ELSE 'user' END,
    NEW.user_id,
    NEW.user_id,
    'audit_log',
    NEW.audit_id::text,
    1,
    'reconstructed',
    jsonb_build_array(jsonb_build_object('auditId', NEW.audit_id::text)),
    NEW.created_at
  )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END;
$$
$fn1$;
    EXECUTE $fn2$
CREATE OR REPLACE FUNCTION record_mdf_board_history_from_audit_relation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type <> 'order' THEN
    RETURN NEW;
  END IF;

  INSERT INTO mdf_board_history_events (
    event_key, correlation_key, step_code, event_sequence, order_id,
    subject_kind, subject_id, display_card_kind, display_card_id, event_kind,
    reason_code, reason_context, consequence_context, actor_kind, actor_user_id,
    triggered_by_user_id, source_event_type, source_event_id, rule_version,
    provenance, evidence_refs, occurred_at
  )
  SELECT
    'audit:' || log.audit_id::text || ':order:' || NEW.entity_id::text,
    COALESCE(NULLIF(log.request_id, ''), log.audit_id::text),
    log.event,
    0,
    NEW.entity_id,
    CASE
      WHEN log.event LIKE 'cnc.telegram_packet.%' OR log.event LIKE 'cnc.manual_svg_upload.%' THEN 'packet'
      WHEN log.event LIKE 'cut_job.%' THEN 'bath'
      WHEN log.event LIKE 'bazis_cut_set.%' THEN 'bazisCutSet'
      WHEN log.event LIKE 'mdf_board.manual_move.%'
        AND split_part(COALESCE(log.entity_id, ''), ':', 1) IN ('order', 'packet', 'bazisCutSet', 'bath')
        THEN split_part(log.entity_id, ':', 1)
      WHEN log.entity_type IN ('mdf_source', 'mdf_board_card')
        AND split_part(COALESCE(log.entity_id, ''), ':', 1) IN ('packet', 'bazisCutSet', 'bath')
        THEN split_part(log.entity_id, ':', 1)
      WHEN log.entity_type = 'mdf_bath' AND COALESCE(log.entity_id, '') ~ '^cut-result:[1-9][0-9]*$' THEN 'bath'
      ELSE 'order'
    END,
    CASE
      WHEN log.event LIKE 'mdf_board.manual_move.%' AND position(':' IN COALESCE(log.entity_id, '')) > 0
        THEN substring(log.entity_id FROM position(':' IN log.entity_id) + 1)
      WHEN log.entity_type IN ('mdf_source', 'mdf_board_card')
        AND split_part(COALESCE(log.entity_id, ''), ':', 1) IN ('packet', 'bazisCutSet', 'bath')
        THEN substring(log.entity_id FROM position(':' IN log.entity_id) + 1)
      WHEN log.entity_type = 'mdf_bath' AND COALESCE(log.entity_id, '') ~ '^cut-result:[1-9][0-9]*$' THEN log.entity_id
      ELSE COALESCE(NULLIF(log.entity_id, ''), NEW.entity_id::text, log.audit_id::text)
    END,
    NULL,
    NULL,
    CASE
      WHEN log.event = 'orders.create' THEN 'not_on_board'
      WHEN log.event IN ('orders.delete', 'bazis_cut_set.deleted') THEN 'disappeared'
      WHEN log.event = 'orders.restore' THEN 'first_known'
      WHEN log.event LIKE 'mdf_board.manual_move.%' OR log.event = 'orders.status_change' THEN 'moved'
      WHEN log.event IN ('cut_job.calculated', 'bazis_cut_set.created', 'cnc.telegram_packet.ingested') THEN 'appeared'
      ELSE 'progress'
    END,
    upper(regexp_replace(log.event, '[^A-Za-z0-9]+', '_', 'g')),
    jsonb_build_object(
      'event', log.event,
      'statusName', log.status_name,
      'statusCode', log.status_code,
      'before', COALESCE(log.before_json, '{}'::jsonb),
      'after', COALESCE(log.after_json, '{}'::jsonb),
      'diff', COALESCE(log.diff_json, '{}'::jsonb)
    ),
    COALESCE(log.metadata_json, '{}'::jsonb),
    CASE WHEN log.user_id IS NULL THEN 'system' ELSE 'user' END,
    log.user_id,
    log.user_id,
    'audit_log',
    log.audit_id::text,
    1,
    'reconstructed',
    jsonb_build_array(jsonb_build_object('auditId', log.audit_id::text)),
    log.created_at
  FROM audit_log log
  WHERE log.audit_id = NEW.audit_id
    AND (
      log.event LIKE 'orders.%' OR log.event LIKE 'order.%' OR log.event LIKE 'production.%'
      OR log.event LIKE 'cnc.telegram_packet.%' OR log.event LIKE 'cnc.manual_svg_upload.%'
      OR log.event LIKE 'cut_job.%' OR log.event LIKE 'bazis_cut_set.%'
      OR log.event LIKE 'mdf_board.%' OR log.event LIKE 'status_automation.%'
      OR log.event = 'mdf.order_correction.requested'
    )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END;
$$
$fn2$;
  END IF;
END;
$do$;

COMMENT ON TABLE mdf_revision_presentation IS
  'Presentation binding of an accepted MDF revision: digest of the raw composition-sensitive card presentation at the time the revision was established from raw data; carrying revisions inherit it.';

COMMIT;
