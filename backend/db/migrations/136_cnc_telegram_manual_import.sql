-- Explicit, user-approved Telegram discovery/import workflow (Phase B).
BEGIN;

-- Versioned canonical layout fingerprints are written by parsers that support
-- layout matching; never derive a match from JSONB serialization order.
ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS layout_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_layout_fingerprint
  ON cnc_telegram_packets(layout_fingerprint)
  WHERE layout_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS cnc_telegram_import_scans (
  scan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  source_chat_id TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  business_timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  lease_token TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  worker_instance_id UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  days_scanned INTEGER NOT NULL DEFAULT 0,
  messages_scanned INTEGER NOT NULL DEFAULT 0,
  candidates_found INTEGER NOT NULL DEFAULT 0,
  warnings_count INTEGER NOT NULL DEFAULT 0,
  truncated BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_cnc_tg_import_scan_range CHECK (date_to >= date_from AND date_to <= date_from + 30),
  CONSTRAINT chk_cnc_tg_import_scan_status CHECK (status IN ('pending','processing','ready','failed','expired')),
  CONSTRAINT chk_cnc_tg_import_scan_attempts CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT chk_cnc_tg_import_scan_counts CHECK (days_scanned >= 0 AND messages_scanned >= 0 AND candidates_found >= 0 AND warnings_count >= 0),
  CONSTRAINT chk_cnc_tg_import_scan_error CHECK (error_message IS NULL OR char_length(error_message) BETWEEN 1 AND 500),
  CONSTRAINT chk_cnc_tg_import_scan_lease CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_generation > 0 AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND worker_instance_id IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_import_scan_active_selection
  ON cnc_telegram_import_scans(requested_by, request_hash)
  WHERE status IN ('pending','processing');
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_import_scan_idempotency
  ON cnc_telegram_import_scans(requested_by, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_scan_claim
  ON cnc_telegram_import_scans(status, created_at, scan_id)
  WHERE status IN ('pending','processing');

CREATE TABLE IF NOT EXISTS cnc_telegram_import_candidates (
  candidate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES cnc_telegram_import_scans(scan_id) ON DELETE CASCADE,
  source_chat_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  source_thread_id BIGINT,
  source_created_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  workday DATE NOT NULL,
  svg_message_id BIGINT NOT NULL,
  gcode_message_id BIGINT,
  screenshot_message_id BIGINT,
  svg_file_name TEXT NOT NULL,
  gcode_file_name TEXT,
  screenshot_file_name TEXT,
  svg_content_sha256 TEXT NOT NULL,
  gcode_content_sha256 TEXT,
  screenshot_content_sha256 TEXT,
  source_set_fingerprint TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  layout_fingerprint TEXT,
  parsed_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  cut_layout_json JSONB,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  eligibility_status TEXT NOT NULL DEFAULT 'valid',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cnc_tg_import_candidate_source UNIQUE (scan_id, source_chat_id, source_message_id),
  CONSTRAINT chk_cnc_tg_import_candidate_status CHECK (eligibility_status IN ('valid','invalid','incomplete','expired')),
  CONSTRAINT chk_cnc_tg_import_candidate_sha CHECK (svg_content_sha256 ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT chk_cnc_tg_import_candidate_warnings CHECK (jsonb_typeof(warnings_json) = 'array'),
  CONSTRAINT chk_cnc_tg_import_candidate_snapshot CHECK (jsonb_typeof(parsed_snapshot_json) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_candidate_scan ON cnc_telegram_import_candidates(scan_id, created_at, candidate_id);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_candidate_sha ON cnc_telegram_import_candidates(svg_content_sha256);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_candidate_layout ON cnc_telegram_import_candidates(layout_fingerprint) WHERE layout_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS cnc_telegram_import_candidate_matches (
  match_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES cnc_telegram_import_candidates(candidate_id) ON DELETE CASCADE,
  match_kind TEXT NOT NULL,
  packet_id UUID REFERENCES cnc_telegram_packets(packet_id) ON DELETE SET NULL,
  cut_job_id BIGINT REFERENCES cut_job(cut_job_id) ON DELETE SET NULL,
  cut_result_id BIGINT REFERENCES cut_result(cut_result_id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_tg_import_match_kind CHECK (match_kind IN ('same_telegram_source','sent_by_erp_manual_upload','exact_svg_content','same_layout')),
  CONSTRAINT chk_cnc_tg_import_match_target CHECK (packet_id IS NOT NULL OR cut_job_id IS NOT NULL OR cut_result_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_import_candidate_match
  ON cnc_telegram_import_candidate_matches(candidate_id, match_kind, COALESCE(packet_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(cut_job_id, -1), COALESCE(cut_result_id, -1));
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_candidate_matches_candidate ON cnc_telegram_import_candidate_matches(candidate_id, match_kind);

CREATE TABLE IF NOT EXISTS cnc_telegram_import_requests (
  import_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES cnc_telegram_import_scans(scan_id) ON DELETE RESTRICT,
  requested_by BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  selection_hash TEXT NOT NULL,
  confirmation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  repeat_of_import_request_id UUID REFERENCES cnc_telegram_import_requests(import_request_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  duplicate_match_version BIGINT NOT NULL DEFAULT 1,
  selected_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_cnc_tg_import_request_status CHECK (status IN ('draft','pending','processing','completed','partial','failed')),
  CONSTRAINT chk_cnc_tg_import_request_counts CHECK (selected_count >= 0 AND imported_count >= 0 AND failed_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_import_request_idempotency ON cnc_telegram_import_requests(requested_by, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_import_request_active_selection
  ON cnc_telegram_import_requests(scan_id, requested_by, selection_hash)
  WHERE status IN ('draft','pending','processing');
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_request_owner ON cnc_telegram_import_requests(requested_by, created_at DESC);

CREATE TABLE IF NOT EXISTS cnc_telegram_import_items (
  import_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_request_id UUID NOT NULL REFERENCES cnc_telegram_import_requests(import_request_id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL REFERENCES cnc_telegram_import_candidates(candidate_id) ON DELETE RESTRICT,
  duplicate_acknowledged BOOLEAN NOT NULL DEFAULT false,
  duplicate_match_version BIGINT NOT NULL,
  duplicate_snapshot_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_token TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_worker_instance_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  source_set_fingerprint TEXT NOT NULL,
  packet_id UUID REFERENCES cnc_telegram_packets(packet_id) ON DELETE SET NULL,
  cut_job_id BIGINT REFERENCES cut_job(cut_job_id) ON DELETE SET NULL,
  cut_result_id BIGINT REFERENCES cut_result(cut_result_id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cnc_tg_import_item_candidate UNIQUE (import_request_id, candidate_id),
  CONSTRAINT chk_cnc_tg_import_item_status CHECK (status IN ('pending','processing','confirmation_required','imported','failed','unknown')),
  CONSTRAINT chk_cnc_tg_import_item_attempts CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT chk_cnc_tg_import_item_ack CHECK (
    jsonb_typeof(duplicate_snapshot_json) = 'array'
    AND (duplicate_acknowledged OR jsonb_array_length(duplicate_snapshot_json) = 0
         OR status IN ('pending','confirmation_required'))
  ),
  CONSTRAINT chk_cnc_tg_import_item_lease CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_generation > 0 AND lease_worker_instance_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'processing'
  ),
  CONSTRAINT chk_cnc_tg_import_item_error CHECK (error_message IS NULL OR char_length(error_message) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_item_claim ON cnc_telegram_import_items(status, created_at, import_item_id) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_item_request ON cnc_telegram_import_items(import_request_id, status);

-- The candidate match snapshot is versioned independently from the import item;
-- a refreshed lookup can therefore fence a confirmation without changing its
-- selection identity.
ALTER TABLE cnc_telegram_import_candidates
  ADD COLUMN IF NOT EXISTS duplicate_match_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE cnc_telegram_import_candidates
  ADD CONSTRAINT chk_cnc_tg_import_candidate_match_version
  CHECK (duplicate_match_version > 0);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_candidate_match_version
  ON cnc_telegram_import_candidates(candidate_id, duplicate_match_version);

INSERT INTO permissions_catalog (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
VALUES ('cnc.telegram_import.manage_all', 'cut', 'Управление импортом Telegram', 'Доступ к чужим заявкам явного импорта Telegram', 162, false, true)
ON CONFLICT (permission_name) DO UPDATE SET is_active=true, updated_at=now();
INSERT INTO role_permissions (role_id, permission_name, is_enabled)
SELECT role_id, 'cnc.telegram_import.manage_all', true FROM roles WHERE role_code IN ('admin','superadmin')
ON CONFLICT (role_id, permission_name) DO NOTHING;
UPDATE permissions_state SET version=version+1, updated_at=now() WHERE id=true;

COMMIT;
