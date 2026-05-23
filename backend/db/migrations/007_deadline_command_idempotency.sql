ALTER TABLE deadline_instances
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS deadline_instances_idempotency_key_uidx
  ON deadline_instances (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
