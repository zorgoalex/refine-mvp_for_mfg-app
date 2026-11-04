-- «Распилено» from the CNC chat: the 👍 under a file the bot sent is recorded as an incoming signal, independently of
-- the MDF board. The worker re-reads reactions of bot-sent messages (claim → report); the server keeps:
--   cnc_chat_signal_messages      — every observed message (role file/comment/unknown, last counts, poll schedule);
--   cnc_chat_signal_claims        — one worker claim with the return generation of each packet at issue time;
--   cnc_chat_sawn_signals         — the journal: one row per reactor episode (who, when, when cleared);
--   cnc_chat_sawn_packet_signals  — packet level «no active 👍 → 👍» transitions and their application state;
--   cnc_chat_signal_return_resets — deferred clearing of a return barrier bound to one return generation;
--   cnc_chat_signal_commands      — idempotency of user commands (settings, apply-pending confirm).
-- Additive: no existing table changes. The packet completion itself uses the existing columns.
BEGIN;

CREATE TABLE IF NOT EXISTS cnc_chat_signal_messages (
  chat_id text NOT NULL,
  message_id bigint NOT NULL CHECK (message_id > 0),
  send_request_id uuid NOT NULL REFERENCES cnc_manual_svg_telegram_send_requests(request_id) ON DELETE CASCADE,
  packet_id uuid REFERENCES cnc_telegram_packets(packet_id) ON DELETE SET NULL,
  message_role text NOT NULL CHECK (message_role IN ('file','comment','unknown')),
  role_source text NOT NULL CHECK (role_source IN ('worker_audit','send_order','ambiguous')),
  send_finished_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  observation_state text NOT NULL DEFAULT 'never_polled' CHECK (observation_state IN ('never_polled','present','missing')),
  thumbs_count integer NOT NULL DEFAULT 0 CHECK (thumbs_count >= 0),
  can_see_list boolean,
  authors_state text NOT NULL DEFAULT 'not_requested'
    CHECK (authors_state IN ('not_requested','unavailable','partial','complete')),
  authors_checked_at timestamptz,
  last_polled_at timestamptz,
  last_successful_poll_at timestamptz,
  last_positive_observed_at timestamptz,
  last_negative_observed_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  claimed_by uuid,
  claim_expires_at timestamptz,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_cnc_chat_signal_messages_due ON cnc_chat_signal_messages (chat_id, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_cnc_chat_signal_messages_packet ON cnc_chat_signal_messages (packet_id);
CREATE INDEX IF NOT EXISTS idx_cnc_chat_signal_messages_send ON cnc_chat_signal_messages (send_request_id);

CREATE TABLE IF NOT EXISTS cnc_chat_signal_claims (
  claim_id uuid PRIMARY KEY,
  claim_token_hash text NOT NULL,
  chat_id text NOT NULL,
  worker_instance_id uuid NOT NULL,
  lease_generation bigint NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  message_ids jsonb NOT NULL CHECK (jsonb_typeof(message_ids) = 'array'),
  packet_return_refs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(packet_return_refs) = 'object'),
  reported_at timestamptz,
  report_digest text,
  report_request_id text
);
CREATE INDEX IF NOT EXISTS idx_cnc_chat_signal_claims_issued ON cnc_chat_signal_claims (issued_at);

CREATE TABLE IF NOT EXISTS cnc_chat_sawn_packet_signals (
  packet_signal_id bigserial PRIMARY KEY,
  packet_id uuid NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_claim_id uuid REFERENCES cnc_chat_signal_claims(claim_id),
  origin text NOT NULL CHECK (origin IN ('live','baseline')),
  freshness text NOT NULL CHECK (freshness IN ('fresh','late')),
  reacted_at timestamptz,
  last_positive_observed_at timestamptz NOT NULL,
  closed_observed_at timestamptz,
  close_reason text CHECK (close_reason IN ('cleared','message_missing')),
  apply_state text NOT NULL CHECK (apply_state IN ('pending','held_disabled','held_baseline','held_history',
    'held_return_barrier','held_engine','retry_wait','failed_final','applied','already_completed','closed')),
  apply_attempts integer NOT NULL DEFAULT 0 CHECK (apply_attempts >= 0),
  next_apply_at timestamptz,
  last_apply_error text,
  applied_at timestamptz,
  applied_by bigint REFERENCES users(user_id),
  apply_audit_id text,
  apply_request_id text,
  open_audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_chat_sawn_packet_signals_close CHECK ((closed_observed_at IS NULL) = (close_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_chat_sawn_packet_signals_open
  ON cnc_chat_sawn_packet_signals (packet_id) WHERE closed_observed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cnc_chat_sawn_packet_signals_apply
  ON cnc_chat_sawn_packet_signals (apply_state, next_apply_at);

CREATE TABLE IF NOT EXISTS cnc_chat_sawn_signals (
  signal_id bigserial PRIMARY KEY,
  chat_id text NOT NULL,
  message_id bigint NOT NULL,
  packet_id uuid REFERENCES cnc_telegram_packets(packet_id) ON DELETE SET NULL,
  send_request_id uuid NOT NULL,
  packet_signal_id bigint REFERENCES cnc_chat_sawn_packet_signals(packet_signal_id) ON DELETE SET NULL,
  cutting_sequence_no integer,
  message_role text NOT NULL CHECK (message_role IN ('file','comment','unknown')),
  reactor_peer_type text NOT NULL CHECK (reactor_peer_type IN ('user','channel','chat','anonymous')),
  reactor_peer_id text NOT NULL DEFAULT '0' CHECK (reactor_peer_id ~ '^[0-9]{1,20}$'),
  reactor_display_name text CHECK (char_length(reactor_display_name) <= 200),
  reactor_username text CHECK (char_length(reactor_username) <= 64),
  reacted_at timestamptz,
  first_observed_at timestamptz NOT NULL,
  first_claim_id uuid REFERENCES cnc_chat_signal_claims(claim_id),
  cleared_observed_at timestamptz,
  message_missing_observed_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('live','baseline')),
  request_id text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_chat_sawn_signals_anonymous CHECK ((reactor_peer_type = 'anonymous') = (reactor_peer_id = '0')),
  CONSTRAINT fk_cnc_chat_sawn_signals_message FOREIGN KEY (chat_id, message_id)
    REFERENCES cnc_chat_signal_messages(chat_id, message_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_chat_sawn_signals_open_episode
  ON cnc_chat_sawn_signals (chat_id, message_id, reactor_peer_type, reactor_peer_id)
  WHERE cleared_observed_at IS NULL AND message_missing_observed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cnc_chat_sawn_signals_observed ON cnc_chat_sawn_signals (first_observed_at DESC, signal_id DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_chat_sawn_signals_packet ON cnc_chat_sawn_signals (packet_id, signal_id DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_chat_sawn_signals_cutting_no ON cnc_chat_sawn_signals (cutting_sequence_no);

CREATE TABLE IF NOT EXISTS cnc_chat_signal_return_resets (
  reset_id bigserial PRIMARY KEY,
  packet_id uuid NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE CASCADE,
  packet_signal_id bigint REFERENCES cnc_chat_sawn_packet_signals(packet_signal_id) ON DELETE SET NULL,
  return_ref text NOT NULL,
  claim_id uuid NOT NULL REFERENCES cnc_chat_signal_claims(claim_id),
  negative_observed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','retry_wait','done','cancelled_stale','skipped_engine')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  finished_at timestamptz,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_chat_signal_return_resets_active
  ON cnc_chat_signal_return_resets (packet_id, return_ref) WHERE state IN ('pending','retry_wait');
CREATE INDEX IF NOT EXISTS idx_cnc_chat_signal_return_resets_due ON cnc_chat_signal_return_resets (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS cnc_chat_signal_commands (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  command text NOT NULL CHECK (command IN ('settings','apply_pending_confirm')),
  actor_user_id bigint NOT NULL REFERENCES users(user_id),
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The automatic move is OFF until the user switches it on; activation (baseline boundary) is set by the first claim.
INSERT INTO app_settings (setting_key, value_json, description, is_active)
VALUES ('cnc_chat_signals.apply_to_packet', '{"value": false}'::jsonb,
        'Переносить файл станка в «Распилено» по 👍 из чата CNC (сигнал фиксируется в журнале всегда)', true)
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
