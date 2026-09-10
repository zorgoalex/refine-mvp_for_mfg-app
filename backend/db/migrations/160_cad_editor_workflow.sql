-- Additive editor workflow. Never rewrites original, revision or artifact data.
BEGIN;
CREATE TABLE IF NOT EXISTS cad_export_reviews (
  id uuid PRIMARY KEY, actor_id bigint NOT NULL, variant_id uuid NOT NULL,
  revision integer NOT NULL, run_id uuid NOT NULL REFERENCES cad_runs(id),
  remote_job_id text NOT NULL, source_hash text NOT NULL, source_status jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  FOREIGN KEY(variant_id,revision) REFERENCES cad_variant_revisions(variant_id,revision)
);
CREATE INDEX IF NOT EXISTS cad_export_reviews_actor ON cad_export_reviews(actor_id,run_id);
CREATE TABLE IF NOT EXISTS cad_approval_commands (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES cad_runs(id),
  group_id uuid NOT NULL, manufacturing_hash text NOT NULL, reason text NOT NULL,
  actor jsonb NOT NULL, request_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
  receipt jsonb, last_error text, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='succeeded') = (receipt IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cad_approval_commands_pending ON cad_approval_commands(next_attempt_at) WHERE status='pending';
COMMIT;
