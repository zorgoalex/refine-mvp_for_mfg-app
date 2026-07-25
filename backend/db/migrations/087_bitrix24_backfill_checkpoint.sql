CREATE TABLE IF NOT EXISTS crm_sync_backfill_checkpoint (
  scope TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  last_client_id TEXT,
  last_order_id TEXT,
  processed_clients BIGINT NOT NULL DEFAULT 0,
  processed_orders BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_crm_sync_backfill_scope
    CHECK (scope IN ('clients', 'all')),
  CONSTRAINT chk_crm_sync_backfill_phase
    CHECK (phase IN ('clients', 'orders', 'completed')),
  CONSTRAINT chk_crm_sync_backfill_scope_phase
    CHECK (scope = 'all' OR phase <> 'orders'),
  CONSTRAINT chk_crm_sync_backfill_scope_state
    CHECK (
      scope = 'all'
      OR (last_order_id IS NULL AND processed_orders = 0)
    ),
  CONSTRAINT chk_crm_sync_backfill_phase_state
    CHECK (
      phase <> 'clients'
      OR (last_order_id IS NULL AND processed_orders = 0)
    ),
  CONSTRAINT chk_crm_sync_backfill_client_cursor
    CHECK (last_client_id IS NULL OR last_client_id ~ '^[0-9]+$'),
  CONSTRAINT chk_crm_sync_backfill_order_cursor
    CHECK (last_order_id IS NULL OR last_order_id ~ '^[0-9]+$'),
  CONSTRAINT chk_crm_sync_backfill_counts
    CHECK (processed_clients >= 0 AND processed_orders >= 0),
  CONSTRAINT chk_crm_sync_backfill_completed_at
    CHECK ((phase = 'completed') = (completed_at IS NOT NULL))
);

COMMENT ON TABLE crm_sync_backfill_checkpoint IS
  'Durable cursors for restart-safe ERP to Bitrix24 initial backfills.';
