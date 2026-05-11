-- Idempotent order snapshot import/export support.
--
-- The snapshot file format carries source ids from another ERP database.
-- These tables map source entities to local entities so repeated imports update
-- the same records instead of inserting duplicates.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS order_import_runs (
  import_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  local_order_id BIGINT REFERENCES orders(order_id) ON DELETE SET NULL,
  payload_hash TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'apply',
  status TEXT NOT NULL DEFAULT 'processing',
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  imported_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_order_import_runs_mode CHECK (mode IN ('apply', 'dry_run')),
  CONSTRAINT chk_order_import_runs_status CHECK (status IN ('processing', 'completed', 'failed', 'noop'))
);

CREATE INDEX IF NOT EXISTS idx_order_import_runs_source
  ON order_import_runs(source_instance_id, source_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_import_runs_local_order
  ON order_import_runs(local_order_id, created_at DESC)
  WHERE local_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_import_entity_map (
  source_instance_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  local_entity_id TEXT NOT NULL,
  local_order_id BIGINT REFERENCES orders(order_id) ON DELETE CASCADE,
  payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_instance_id, entity_type, source_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_order_import_entity_map_local_order
  ON order_import_entity_map(local_order_id, entity_type)
  WHERE local_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_import_entity_map_local_entity
  ON order_import_entity_map(entity_type, local_entity_id);

COMMIT;
