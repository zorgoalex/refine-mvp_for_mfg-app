-- Append-only domain history and projection state for the MDF work board.

BEGIN;

CREATE TABLE IF NOT EXISTS mdf_board_history_events (
  history_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  correlation_key TEXT NOT NULL,
  step_code TEXT NOT NULL,
  event_sequence INTEGER NOT NULL DEFAULT 0,
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  display_card_kind TEXT,
  display_card_id TEXT,
  event_kind TEXT NOT NULL,
  from_column TEXT,
  to_column TEXT,
  automatic_column TEXT,
  reason_code TEXT NOT NULL,
  reason_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  consequence_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_kind TEXT NOT NULL,
  actor_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  triggered_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  source_event_type TEXT NOT NULL,
  source_event_id TEXT,
  rule_version INTEGER NOT NULL DEFAULT 1,
  provenance TEXT NOT NULL DEFAULT 'recorded',
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mdf_history_subject_kind CHECK (
    subject_kind IN ('order', 'packet', 'bazisCutSet', 'bath')
  ),
  CONSTRAINT chk_mdf_history_event_kind CHECK (
    event_kind IN ('appeared', 'moved', 'progress', 'disappeared', 'not_on_board', 'first_known')
  ),
  CONSTRAINT chk_mdf_history_actor_kind CHECK (actor_kind IN ('user', 'system')),
  CONSTRAINT chk_mdf_history_provenance CHECK (
    provenance IN ('recorded', 'reconstructed', 'net_reconstructed')
  ),
  CONSTRAINT chk_mdf_history_rule_version CHECK (rule_version > 0),
  CONSTRAINT chk_mdf_history_subject_id CHECK (length(btrim(subject_id)) BETWEEN 1 AND 240)
);

CREATE INDEX IF NOT EXISTS idx_mdf_board_history_order_time
  ON mdf_board_history_events(order_id, occurred_at, event_sequence, history_event_id);
CREATE INDEX IF NOT EXISTS idx_mdf_board_history_subject
  ON mdf_board_history_events(subject_kind, subject_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mdf_board_history_correlation
  ON mdf_board_history_events(correlation_key, event_sequence, history_event_id);

CREATE OR REPLACE FUNCTION reject_mdf_board_history_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'mdf_board_history_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_mdf_board_history_events_append_only ON mdf_board_history_events;
CREATE TRIGGER trg_mdf_board_history_events_append_only
BEFORE UPDATE OR DELETE ON mdf_board_history_events
FOR EACH ROW
EXECUTE FUNCTION reject_mdf_board_history_event_mutation();

CREATE TABLE IF NOT EXISTS mdf_board_history_state (
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  visible BOOLEAN NOT NULL DEFAULT false,
  current_column TEXT,
  automatic_column TEXT,
  diagnostic_fingerprint TEXT NOT NULL,
  projection_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, subject_kind, subject_id),
  CONSTRAINT chk_mdf_history_state_subject_kind CHECK (
    subject_kind IN ('order', 'packet', 'bazisCutSet', 'bath')
  ),
  CONSTRAINT chk_mdf_history_state_version CHECK (projection_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_mdf_board_history_state_subject
  ON mdf_board_history_state(subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS mdf_board_history_coverage (
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  evidence_from TIMESTAMPTZ,
  gaps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, source_kind),
  CONSTRAINT chk_mdf_history_coverage_source CHECK (
    source_kind IN ('order', 'packet', 'bazisCutSet', 'bath', 'manual', 'status', 'hide_delete')
  ),
  CONSTRAINT chk_mdf_history_coverage_status CHECK (
    coverage_status IN ('recorded_exact', 'reconstructed_complete', 'partial', 'none')
  )
);

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
    ELSE 'order'
  END;
  resolved_subject_id := CASE
    WHEN NEW.event LIKE 'mdf_board.manual_move.%' AND position(':' IN COALESCE(NEW.entity_id, '')) > 0
      THEN substring(NEW.entity_id FROM position(':' IN NEW.entity_id) + 1)
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
    'recorded',
    jsonb_build_array(jsonb_build_object('auditId', NEW.audit_id::text)),
    NEW.created_at
  )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_mdf_board_history_from_audit ON audit_log;
CREATE TRIGGER trg_record_mdf_board_history_from_audit
AFTER INSERT ON audit_log
FOR EACH ROW
EXECUTE FUNCTION record_mdf_board_history_from_audit();

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
      ELSE 'order'
    END,
    CASE
      WHEN log.event LIKE 'mdf_board.manual_move.%' AND position(':' IN COALESCE(log.entity_id, '')) > 0
        THEN substring(log.entity_id FROM position(':' IN log.entity_id) + 1)
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
    'recorded',
    jsonb_build_array(jsonb_build_object('auditId', log.audit_id::text)),
    log.created_at
  FROM audit_log log
  WHERE log.audit_id = NEW.audit_id
    AND (
      log.event LIKE 'orders.%' OR log.event LIKE 'order.%' OR log.event LIKE 'production.%'
      OR log.event LIKE 'cnc.telegram_packet.%' OR log.event LIKE 'cnc.manual_svg_upload.%'
      OR log.event LIKE 'cut_job.%' OR log.event LIKE 'bazis_cut_set.%'
      OR log.event LIKE 'mdf_board.%' OR log.event LIKE 'status_automation.%'
    )
  ON CONFLICT (event_key) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_mdf_board_history_from_audit_relation ON audit_log_related_entity;
CREATE TRIGGER trg_record_mdf_board_history_from_audit_relation
AFTER INSERT ON audit_log_related_entity
FOR EACH ROW
EXECUTE FUNCTION record_mdf_board_history_from_audit_relation();

COMMENT ON TABLE mdf_board_history_events IS
  'mdf-board-history-v1: append-only causal transitions and progress evidence';
COMMENT ON TABLE mdf_board_history_state IS
  'mdf-board-history-v1: latest projection used for consistency checks and transition recording';
COMMENT ON TABLE mdf_board_history_coverage IS
  'mdf-board-history-v1: per-order per-source evidence coverage; never infer completeness from current state';

COMMIT;
