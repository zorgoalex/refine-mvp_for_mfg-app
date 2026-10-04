-- 1C agent integration, stage E2: command queue (lease/received/result).
-- Transport only: business modules enqueue through the OnecCommandQueue port.
BEGIN;

CREATE TABLE onec_agent_commands (
  command_id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  source_id bigint NOT NULL REFERENCES onec_sources(source_id),
  command_type text NOT NULL CHECK (command_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  command_kind text NOT NULL CHECK (command_kind IN ('admin','business')),
  payload_version integer NOT NULL CHECK (payload_version > 0),
  -- Canonical payload bytes (agent-payload-sha256-base64-v1), sent to the agent verbatim.
  -- NULL only after retention purge of a terminal command.
  payload_canonical text,
  payload_hash text NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
  priority integer NOT NULL DEFAULT 0,
  ordering_key text CHECK (ordering_key IS NULL OR length(ordering_key) BETWEEN 1 AND 200),
  correlation_id uuid,
  not_before_utc timestamptz,
  expires_at_utc timestamptz,
  requested_by jsonb,
  source_module text NOT NULL CHECK (length(source_module) BETWEEN 1 AND 64),
  source_entity_type text,
  source_entity_id text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','leased','received','succeeded','business_error','dead_letter','expired',
    'cancelled','expired_undelivered')),
  lease_id uuid,
  lease_expires_at timestamptz,
  lease_count integer NOT NULL DEFAULT 0,
  leased_at timestamptz,
  received_at timestamptz,
  result_body text,
  result_sha256 text,
  result_error_code text,
  result_received_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by bigint REFERENCES users(user_id),
  payload_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_module, idempotency_key),
  CHECK (payload_canonical IS NOT NULL OR payload_purged_at IS NOT NULL)
);
-- Lease scan: issuable commands of one agent in priority order.
CREATE INDEX onec_agent_commands_lease_idx
  ON onec_agent_commands(agent_id, priority DESC, created_at, command_id)
  WHERE status IN ('queued','leased');
-- Ordering-key predecessor check.
CREATE INDEX onec_agent_commands_ordering_idx
  ON onec_agent_commands(agent_id, ordering_key, created_at, command_id)
  WHERE ordering_key IS NOT NULL AND status IN ('queued','leased');
CREATE INDEX onec_agent_commands_expiry_idx
  ON onec_agent_commands(expires_at_utc) WHERE expires_at_utc IS NOT NULL AND status IN ('queued','leased');
CREATE INDEX onec_agent_commands_journal_idx ON onec_agent_commands(agent_id, created_at DESC);
CREATE INDEX onec_agent_commands_source_idx
  ON onec_agent_commands(source_module, source_entity_type, source_entity_id)
  WHERE source_entity_id IS NOT NULL;

COMMIT;
