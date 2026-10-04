-- 1C agent integration, stage E3a: ETL intake (runs, batches, staging) and the
-- mirror of 1C data. Additive only. The mirror is a copy of 1C, never a source
-- for business tables here: projection into ERP entities is E4.
-- Tables use the onec_etl_ prefix in public (plan §5.2 "onec_etl"): isolated
-- integration schemas and the migration probes work on search_path/public.
-- Backups exclude their data (--exclude-table-data='public.onec_etl_*'); after a
-- restore a new full export rebuilds them (plan §6.8).
BEGIN;

CREATE TABLE onec_etl_runs (
  run_id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  source_id bigint NOT NULL REFERENCES onec_sources(source_id),
  -- Human number and the never-reused reference of the source generation the run belongs to.
  source_generation bigint NOT NULL,
  generation_ref uuid NOT NULL,
  -- X-Source-Namespace of the run (null for runs started before the agent sent it).
  source_namespace text,
  mode text CHECK (mode IN ('bootstrap_full','entity_reload','incremental')),
  mode_origin text CHECK (mode_origin IN ('complete_body','command_result','no_pending_etl_command')),
  command_id uuid,
  status text NOT NULL DEFAULT 'receiving' CHECK (status IN ('receiving','completed','abandoned')),
  first_batch_at timestamptz,
  completion_sha256 text,
  completion jsonb,
  completed_at timestamptz,
  entities_failed integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onec_etl_runs_agent_idx ON onec_etl_runs(agent_id, created_at DESC);
CREATE INDEX onec_etl_runs_open_idx ON onec_etl_runs(created_at) WHERE status = 'receiving';

CREATE TABLE onec_etl_batches (
  batch_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES onec_etl_runs(run_id),
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  entity_code text NOT NULL CHECK (entity_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  uncompressed_bytes bigint,
  -- base64 SHA-256 of the compressed body, as sent in X-Content-SHA256.
  content_sha256 text NOT NULL,
  compressed_bytes bigint,
  spool_path text,
  status text NOT NULL CHECK (status IN ('receiving','stored','parsing','parsed','invalid','discarded','finalized')),
  receiving_owner uuid,
  receiving_heartbeat_at timestamptz,
  invalid_reason text,
  parse_attempt integer NOT NULL DEFAULT 0,
  parse_heartbeat_at timestamptz,
  parsed_rows integer,
  ack jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz,
  parsed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onec_etl_batches_run_idx ON onec_etl_batches(run_id, entity_code);
CREATE INDEX onec_etl_batches_work_idx ON onec_etl_batches(status, updated_at)
  WHERE status IN ('receiving','stored','parsing');

-- Parsed rows of unfinished runs; rebuilt from the spool file after a crash.
CREATE UNLOGGED TABLE onec_etl_staging_rows (
  run_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  line_no integer NOT NULL,
  entity_code text NOT NULL,
  source_key text NOT NULL,
  source_updated_at timestamptz,
  deleted boolean NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (batch_id, line_no)
);
CREATE INDEX onec_etl_staging_rows_run_idx ON onec_etl_staging_rows(run_id, entity_code);

-- Current state of every 1C row (no version history).
CREATE TABLE onec_etl_mirror_rows (
  source_id bigint NOT NULL REFERENCES onec_sources(source_id),
  entity_code text NOT NULL,
  source_key text NOT NULL,
  source_updated_at timestamptz,
  deleted boolean NOT NULL,
  data jsonb NOT NULL,
  row_hash text NOT NULL,
  first_seen_run uuid NOT NULL,
  last_run_id uuid NOT NULL,
  -- Diagnostics only (plan §20): the row was absent from a full read; nothing is deleted.
  missing_in_source_at timestamptz,
  missing_in_source_run uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, entity_code, source_key)
);
CREATE INDEX onec_etl_mirror_rows_missing_idx ON onec_etl_mirror_rows(source_id, entity_code)
  WHERE missing_in_source_at IS NOT NULL;

CREATE TABLE onec_etl_entity_state (
  source_id bigint NOT NULL REFERENCES onec_sources(source_id),
  entity_code text NOT NULL,
  last_run_id uuid,
  last_run_at timestamptz,
  last_status text CHECK (last_status IN ('done','failed')),
  last_read_scope text,
  last_completeness text,
  last_completeness_reason text,
  last_snapshot_at timestamptz,
  last_full_run_id uuid,
  last_full_at timestamptz,
  last_error_code text,
  last_error_message text,
  row_count integer NOT NULL DEFAULT 0,
  deleted_count integer NOT NULL DEFAULT 0,
  missing_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, entity_code)
);

COMMIT;
