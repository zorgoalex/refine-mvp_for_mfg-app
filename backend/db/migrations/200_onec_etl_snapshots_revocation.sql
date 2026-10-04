-- 1C agent integration, stage E3b: snapshot entities (plan §21.2), revocation of
-- a sensitive entity's data (§21.3/§21.6). Additive only.
BEGIN;

-- Entity-level state: revocation (write ban + purge) and the applied snapshot version.
ALTER TABLE onec_etl_entity_state
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by bigint REFERENCES users(user_id),
  ADD COLUMN purged_at timestamptz,
  -- snapshotAtUtc of the snapshot the mirror holds (strictly increasing per entity, agent to-erp/0025).
  ADD COLUMN snapshot_version timestamptz,
  ADD COLUMN snapshot_rejected_reason text;

-- A run keeps the entities revoked while it was open, independent of a later re-enable (§21.3).
ALTER TABLE onec_etl_runs ADD COLUMN revoked_entities text[] NOT NULL DEFAULT '{}';

-- An acknowledged batch discarded by a revocation keeps its ACK (the agent's count must still match).
ALTER TABLE onec_etl_batches ADD COLUMN revoked boolean NOT NULL DEFAULT false;

CREATE INDEX onec_etl_batches_entity_idx ON onec_etl_batches(entity_code, status);

-- The identity the agent reported last (session start or heartbeat): what the operator confirms on rebaseline.
ALTER TABLE onec_sources
  ADD COLUMN observed_identity jsonb,
  ADD COLUMN observed_identity_at timestamptz;

COMMIT;
