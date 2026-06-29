-- 046_detail_label_generations.sql
-- Allow label generations for an explicit detail batch that can span orders.

BEGIN;

ALTER TABLE order_label_generations
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE order_label_generations
  ADD COLUMN IF NOT EXISTS generation_scope TEXT NOT NULL DEFAULT 'order',
  ADD COLUMN IF NOT EXISTS scope_json JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE order_label_generations
  ADD CONSTRAINT chk_order_label_generations_scope
  CHECK (generation_scope IN ('order', 'details'));

ALTER TABLE order_label_generations
  ADD CONSTRAINT chk_order_label_generations_scope_json_object
  CHECK (jsonb_typeof(scope_json) = 'object');

CREATE INDEX IF NOT EXISTS idx_order_label_generations_scope_generated_at
  ON order_label_generations (generation_scope, generated_at DESC);

COMMIT;
