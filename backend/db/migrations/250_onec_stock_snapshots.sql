-- 1C stock snapshots at a date («срезы остатков на дату»): the queue of requested snapshots, the copied rows and the
-- slot that tells what the service set `stock_balances_at` of the agent configuration must be for a source.
-- New tables only; nothing existing changes. Names are unqualified like in 193–200: the module's test harnesses apply
-- these migrations in their own schema.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS onec_stock_snapshots (
  snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES onec_sources(source_id),
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  -- The 1C base the snapshot belongs to: the never-reused generation reference of the source at request time
  -- (compared by equality with onec_sources.generation_ref and onec_etl_runs.generation_ref) and, for the audit
  -- only, the human generation number and the database id.
  generation_ref uuid NOT NULL,
  source_generation bigint NOT NULL,
  source_database_id text NULL,
  -- The moment the snapshot describes: local time of the 1C base (what goes into the path), the same instant in UTC
  -- and the zone used to convert.
  moment_local timestamp NOT NULL,
  moment_utc timestamptz NOT NULL,
  time_zone text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CONSTRAINT chk_onec_stock_snapshots_status CHECK (status IN ('requested', 'config_published', 'syncing', 'ready', 'failed')),
  wait_reason text NULL,
  error_code text NULL,
  error_message text NULL,
  forced boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL,
  requested_by bigint NULL REFERENCES users(user_id) ON DELETE SET NULL,
  requested_by_name text NULL,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  config_version bigint NULL,
  command_id uuid NULL,
  run_id uuid NULL,
  rows_count integer NULL CONSTRAINT chk_onec_stock_snapshots_rows_count CHECK (rows_count IS NULL OR rows_count >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  config_published_at timestamptz NULL,
  syncing_at timestamptz NULL,
  -- When the agent read the register in 1C (not the moment the snapshot describes).
  read_at timestamptz NULL,
  ready_at timestamptz NULL,
  failed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  deleted_by bigint NULL REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT uq_onec_stock_snapshots_idempotency UNIQUE (idempotency_key),
  CONSTRAINT chk_onec_stock_snapshots_final CHECK (
    (status = 'ready') = (ready_at IS NOT NULL) AND (status = 'failed') = (failed_at IS NOT NULL)
    AND (status <> 'ready' OR (rows_count IS NOT NULL AND run_id IS NOT NULL)))
);

-- One snapshot of a source is being read at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_stock_snapshots_reading
  ON onec_stock_snapshots (source_id) WHERE status IN ('config_published', 'syncing');
-- The queue of a source, oldest first.
CREATE INDEX IF NOT EXISTS idx_onec_stock_snapshots_queue
  ON onec_stock_snapshots (source_id, status, requested_at, snapshot_id);
-- «The same moment of the same base» for requests without force.
CREATE INDEX IF NOT EXISTS idx_onec_stock_snapshots_moment
  ON onec_stock_snapshots (source_id, generation_ref, moment_local) WHERE deleted_at IS NULL;

-- Every accepted request key and the snapshot it was answered with: the key that created the snapshot and the keys
-- of later requests of the same moment that were answered with it. A repeated key always gets the same snapshot.
CREATE TABLE IF NOT EXISTS onec_stock_snapshot_requests (
  idempotency_key text PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES onec_stock_snapshots(snapshot_id) ON DELETE CASCADE,
  requested_by bigint NULL REFERENCES users(user_id) ON DELETE SET NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onec_stock_snapshot_requests_snapshot ON onec_stock_snapshot_requests (snapshot_id);

CREATE TABLE IF NOT EXISTS onec_stock_snapshot_rows (
  snapshot_id bigint NOT NULL REFERENCES onec_stock_snapshots(snapshot_id) ON DELETE CASCADE,
  row_no integer NOT NULL,
  organization_ref_key uuid NULL,
  item_ref_key uuid NOT NULL,
  characteristic_ref_key uuid NULL,
  batch_ref_key uuid NULL,
  warehouse_ref_key uuid NULL,
  cell_ref_key uuid NULL,
  quantity numeric NOT NULL,
  PRIMARY KEY (snapshot_id, row_no)
);
CREATE INDEX IF NOT EXISTS idx_onec_stock_snapshot_rows_warehouse
  ON onec_stock_snapshot_rows (snapshot_id, warehouse_ref_key);

-- What the service set of the configuration must be for a source and who owns it. `idle` — in the configuration
-- switched off; `active` — switched on for the owner snapshot; `disabling` — the switched-off version is published
-- and waits for the agent; `removed` — taken out of the configuration (before a rollback of the backend image).
CREATE TABLE IF NOT EXISTS onec_stock_snapshot_slot (
  source_id bigint PRIMARY KEY REFERENCES onec_sources(source_id),
  state text NOT NULL
    CONSTRAINT chk_onec_stock_snapshot_slot_state CHECK (state IN ('idle', 'active', 'disabling', 'removed')),
  period_local timestamp NOT NULL,
  owner_snapshot_id bigint NULL REFERENCES onec_stock_snapshots(snapshot_id) ON DELETE SET NULL,
  -- The configuration version in which this state went to the agent.
  config_version bigint NULL,
  -- The last read command queued for the slot.
  command_id uuid NULL,
  state_since timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_stock_snapshot_slot_owner CHECK (state <> 'active' OR owner_snapshot_id IS NOT NULL)
);

COMMENT ON TABLE onec_stock_snapshots IS '1C stock register as of a moment, requested by a user: the queue and the result header';
COMMENT ON TABLE onec_stock_snapshot_requests IS 'Request keys of 1C stock snapshots: each key is answered with one snapshot for ever';
COMMENT ON TABLE onec_stock_snapshot_rows IS 'Rows of a ready 1C stock snapshot (the whole register, all warehouses), copied from the mirror';
COMMENT ON TABLE onec_stock_snapshot_slot IS 'State of the ERP-managed service set stock_balances_at of the agent configuration, one row per source';

COMMIT;
