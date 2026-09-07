-- CAD preparation is additive and independent of commercial order writes.
BEGIN;
CREATE TABLE IF NOT EXISTS cad_workspaces (
  id uuid PRIMARY KEY, order_id bigint NOT NULL UNIQUE REFERENCES orders(order_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cad_sources (
  id uuid PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders(order_id),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cad_variants (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES cad_workspaces(id),
  kind text NOT NULL CHECK(kind IN ('original','working')),
  revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cad_one_original ON cad_variants(workspace_id) WHERE kind='original';
CREATE TABLE IF NOT EXISTS cad_variant_revisions (
  variant_id uuid NOT NULL REFERENCES cad_variants(id), revision integer NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(variant_id,revision)
);
CREATE TABLE IF NOT EXISTS cad_recipe_mappings (
  milling_type_id bigint PRIMARY KEY REFERENCES milling_types(milling_type_id),
  recipe jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cad_commands (
  actor_id bigint NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  result jsonb NOT NULL, access_order_ids bigint[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS cad_runs (
  id uuid PRIMARY KEY, variant_id uuid NOT NULL, revision integer NOT NULL,
  payload jsonb NOT NULL, actor jsonb NOT NULL, request_id text NOT NULL,
  remote_job_id text, status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','partial','failed')),
  last_error text, package_id text, package_requested boolean NOT NULL DEFAULT false,
  package_actor jsonb, package_request_id text,
  CHECK (NOT package_requested OR (package_actor IS NOT NULL AND package_request_id IS NOT NULL)),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(variant_id,revision), FOREIGN KEY(variant_id,revision) REFERENCES cad_variant_revisions(variant_id,revision)
);
CREATE INDEX IF NOT EXISTS cad_runs_pending ON cad_runs(created_at) WHERE status IN ('queued','running');
-- Durable domain event outbox; notification delivery intentionally not enabled.
CREATE TABLE IF NOT EXISTS cad_events (
  id uuid PRIMARY KEY, event text NOT NULL, entity_id text NOT NULL,
  variant_id uuid REFERENCES cad_variants(id), run_id uuid REFERENCES cad_runs(id),
  actor_id bigint, request_id text NOT NULL, audit_id uuid REFERENCES audit_log(audit_id),
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  delivery_status text NOT NULL DEFAULT 'pending', UNIQUE(event,entity_id,request_id)
);
CREATE TABLE IF NOT EXISTS cad_event_sources (
  event_id uuid NOT NULL REFERENCES cad_events(id), order_id bigint NOT NULL,
  detail_id bigint NOT NULL DEFAULT 0, PRIMARY KEY(event_id,order_id,detail_id)
);
CREATE OR REPLACE FUNCTION cad_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CAD_IMMUTABLE_SNAPSHOT'; END $$;
DROP TRIGGER IF EXISTS cad_sources_immutable ON cad_sources;
CREATE TRIGGER cad_sources_immutable BEFORE UPDATE OR DELETE ON cad_sources FOR EACH ROW EXECUTE FUNCTION cad_immutable_record();
DROP TRIGGER IF EXISTS cad_revisions_immutable ON cad_variant_revisions;
CREATE TRIGGER cad_revisions_immutable BEFORE UPDATE OR DELETE ON cad_variant_revisions FOR EACH ROW EXECUTE FUNCTION cad_immutable_record();
CREATE OR REPLACE FUNCTION cad_protect_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='original' THEN RAISE EXCEPTION 'CAD_ORIGINAL_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND (NEW.kind<>OLD.kind OR NEW.workspace_id<>OLD.workspace_id) THEN
    RAISE EXCEPTION 'CAD_VARIANT_IDENTITY_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cad_original_immutable ON cad_variants;
CREATE TRIGGER cad_original_immutable BEFORE UPDATE OR DELETE ON cad_variants FOR EACH ROW EXECUTE FUNCTION cad_protect_original();
COMMIT;
