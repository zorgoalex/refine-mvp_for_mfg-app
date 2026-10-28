-- 270: ERP decides the Bitrix24 responsible user (assignedById) of production deals and clients
-- (plan 2026-10-22 bitrix-responsible-by-erp-manager, GPT-6 R6 APPROVED).
--
-- A Bitrix24 CRM role with the access level «Свои» shows a manager only records where they are the responsible user.
-- ERP is the master: the responsible user of a production order's deal is the Bitrix24 user mapped to the order's
-- manager (else its author); a client's is the one of its latest production order (else the client's author).
--
-- The assignment has its own channel, separate from the ordinary crm-sync outbox:
--   * bitrix24_assignment_cause   — append-only invalidations (actor, transaction, reference). Business triggers only
--                                   INSERT here: they never lock a shared row, so concurrent statements and
--                                   transactions cannot deadlock on the channel;
--   * bitrix24_assignment_entity  — the worker's own row per order/client (claim, retries, what ERP wants); only the
--                                   worker writes it. Causes up to `processed_cause_id` are covered;
--   * bitrix24_assignment_remote  — everything about one Bitrix24 object (baseline, last write, in-flight call,
--                                   restore state); a contact replaced by a company is a new row;
--   * bitrix24_assignment_change  — immutable journal of confirmed assignment changes;
--   * bitrix24_assignment_fanout  — resumable re-check of everything a changed user mapping affects;
--   * bitrix24_assignment_settings — mode of the channel: off (default, nothing is queued), on, restore.
--
-- With mode = 'off' (the default after this migration) every trigger returns at once: the previous backend and the
-- ordinary sync behave exactly as before. Additive: tables, functions, triggers and one unique index.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- A Bitrix24 responsible user must be derived from one ERP user without ambiguity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bitrix24_user_mapping
     WHERE is_active
     GROUP BY erp_user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration 270: an ERP user has several active Bitrix24 user mappings; deactivate the extra ones first';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_user_mapping_active_erp_user
  ON public.bitrix24_user_mapping (erp_user_id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_settings (
  singleton                boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode                     text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'on', 'restore')),
  generation               integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  -- Responsible user that takes over a managed record that lost its manager (a service user without «Свои»).
  release_assigned_by_id   text CHECK (release_assigned_by_id IS NULL OR release_assigned_by_id ~ '^[1-9][0-9]*$'),
  updated_by               bigint,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.bitrix24_assignment_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_entity (
  entity_type              text NOT NULL CHECK (entity_type IN ('order', 'client')),
  erp_id                   bigint NOT NULL CHECK (erp_id > 0),
  -- Highest cause the last claim saw / the highest cause a confirmed write or a deliberate no-op covered.
  seen_cause_id            bigint NOT NULL DEFAULT 0,
  processed_cause_id       bigint NOT NULL DEFAULT 0,
  desired_assigned_by_id   text CHECK (desired_assigned_by_id IS NULL OR desired_assigned_by_id ~ '^[1-9][0-9]*$'),
  desired_source           text CHECK (desired_source IS NULL OR desired_source IN (
                             'manager', 'created_by', 'client_latest_order', 'client_creator', 'release', 'restore')),
  desired_erp_user_id      bigint,
  desired_order_id         bigint,
  attempts                 integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at          timestamptz NOT NULL DEFAULT now(),
  last_error_code          text,
  last_error               text,
  lease_token              uuid,
  lease_until              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, erp_id)
);

CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_remote (
  bitrix_object            text NOT NULL CHECK (bitrix_object IN ('deal', 'contact', 'company')),
  bitrix_id                text NOT NULL CHECK (bitrix_id ~ '^[1-9][0-9]*$'),
  entity_type              text NOT NULL CHECK (entity_type IN ('order', 'client')),
  erp_id                   bigint NOT NULL CHECK (erp_id > 0),
  -- ERP owns `assignedById` of this object (it wrote it once, or enrolled it already correct).
  managed                  boolean NOT NULL DEFAULT false,
  enrolled_at              timestamptz,
  -- `assignedById` before the channel touched this object (read right before the first write or the enrollment).
  original_captured        boolean NOT NULL DEFAULT false,
  original_assigned_by_id  text,
  observed_assigned_by_id  text,
  observed_at              timestamptz,
  sent_assigned_by_id      text,
  sent_at                  timestamptz,
  -- In-flight write: committed before the call; finalized only by the same op_id.
  op_id                    uuid,
  op_target                text CHECK (op_target IS NULL OR op_target ~ '^[1-9][0-9]*$'),
  -- What the decision saw (kept for a recovery that finds the write done): value before, highest covered cause,
  -- source and deciding order.
  op_before                text,
  op_entity_version        bigint,
  -- Exactly the causes the decision saw (sequence order is not commit order: a lower id may commit later).
  op_cause_ids             bigint[],
  op_desired_source        text,
  op_desired_order_id      bigint,
  op_generation            integer,
  op_purpose               text CHECK (op_purpose IS NULL OR op_purpose IN ('assign', 'release', 'restore')),
  op_started_at            timestamptz,
  restore_generation       integer,
  restore_target           text,
  -- The restore command's causes for this target: its provenance survives retries and other targets of the entity.
  restore_cause_ids        bigint[],
  restore_outcome          text CHECK (restore_outcome IS NULL OR restore_outcome IN (
                             'pending', 'restored', 'missing', 'conflict_preserved', 'kept')),
  retired_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bitrix_object, bitrix_id),
  CONSTRAINT chk_bitrix24_assignment_remote_op
    CHECK ((op_id IS NULL) = (op_target IS NULL AND op_entity_version IS NULL AND op_purpose IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_remote_entity
  ON public.bitrix24_assignment_remote (entity_type, erp_id);

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_remote_in_flight
  ON public.bitrix24_assignment_remote (entity_type, erp_id)
  WHERE op_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_remote_restore
  ON public.bitrix24_assignment_remote (restore_generation, restore_outcome)
  WHERE restore_generation IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_cause (
  cause_id                 bigserial PRIMARY KEY,
  entity_type              text NOT NULL CHECK (entity_type IN ('order', 'client')),
  erp_id                   bigint NOT NULL,
  cause_type               text NOT NULL CHECK (cause_type IN (
                             'order_change', 'client_change', 'crm_mapping', 'user_mapping', 'user_change',
                             'bitrix_inbound', 'command')),
  ref_id                   text,
  actor_user_id            bigint,
  correlation_id           text,
  -- Transaction of the change: with xact_at (= audit_log.created_at of rows the same transaction wrote) the request id
  -- of the ERP command is found later.
  xact_id                  bigint NOT NULL DEFAULT txid_current(),
  xact_at                  timestamptz NOT NULL DEFAULT now(),
  processed                boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_cause_open
  ON public.bitrix24_assignment_cause (entity_type, erp_id, cause_id)
  WHERE NOT processed;

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_cause_purge
  ON public.bitrix24_assignment_cause (created_at)
  WHERE processed;

CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_change (
  change_id                uuid PRIMARY KEY,
  entity_type              text NOT NULL CHECK (entity_type IN ('order', 'client')),
  erp_id                   bigint NOT NULL,
  order_id                 bigint,
  client_id                bigint,
  winning_order_id         bigint,
  bitrix_object            text NOT NULL,
  bitrix_id                text NOT NULL,
  before_assigned_by_id    text,
  after_assigned_by_id     text NOT NULL,
  desired_source           text,
  purpose                  text NOT NULL CHECK (purpose IN ('assign', 'release', 'restore')),
  op_id                    uuid NOT NULL UNIQUE,
  generation               integer NOT NULL,
  covered_cause_id         bigint NOT NULL,
  cause_ids                bigint[] NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_change_entity
  ON public.bitrix24_assignment_change (entity_type, erp_id, created_at);

CREATE TABLE IF NOT EXISTS public.bitrix24_assignment_fanout (
  fanout_id                uuid PRIMARY KEY,
  mapping_id               bigint NOT NULL,
  erp_user_ids             bigint[] NOT NULL,
  actor_user_id            bigint,
  correlation_id           text,
  -- orders (manager/author) → clients (author); cursors are the last processed ids.
  phase                    text NOT NULL DEFAULT 'orders' CHECK (phase IN ('orders', 'clients', 'done')),
  cursor_id                bigint NOT NULL DEFAULT 0,
  touched                  integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  CONSTRAINT chk_bitrix24_assignment_fanout_done CHECK ((phase = 'done') = (finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_assignment_fanout_open
  ON public.bitrix24_assignment_fanout (created_at)
  WHERE phase <> 'done';

CREATE OR REPLACE FUNCTION public.bitrix24_assignment_active() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.bitrix24_assignment_settings WHERE mode <> 'off')
$$;

-- ERP user of the session (app.user_id set by backend commands), when it is a plain id; never fails the caller.
CREATE OR REPLACE FUNCTION public.bitrix24_assignment_session_user() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_setting('app.user_id', true) ~ '^[1-9][0-9]{0,17}$'
              THEN current_setting('app.user_id', true)::bigint END
$$;

-- Invalidates entities: appends one cause per entity and nothing else (no shared row is locked). Returns the number
-- of causes; 0 while the channel is off.
CREATE OR REPLACE FUNCTION public.bitrix24_assignment_touch(
  p_entity_types text[],
  p_erp_ids bigint[],
  p_cause_type text,
  p_ref_id text,
  p_actor_user_id bigint,
  p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN 0;
  END IF;
  INSERT INTO public.bitrix24_assignment_cause (entity_type, erp_id, cause_type, ref_id, actor_user_id, correlation_id)
  SELECT DISTINCT input.entity_type, input.erp_id, p_cause_type, p_ref_id,
         COALESCE(p_actor_user_id, public.bitrix24_assignment_session_user()),
         -- erp.request_id: the HTTP request of the backend transaction (set by DatabaseService.transaction).
         COALESCE(p_correlation_id, NULLIF(current_setting('erp.request_id', true), ''))
    FROM unnest(p_entity_types, p_erp_ids) AS input(entity_type, erp_id)
   WHERE input.erp_id IS NOT NULL AND input.erp_id > 0;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Inbound Bitrix24 change of an object the channel owns: re-check it (a manual reassignment is reverted).
CREATE OR REPLACE FUNCTION public.bitrix24_assignment_touch_remote(
  p_bitrix_object text,
  p_bitrix_id text,
  p_ref_id text
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_remote record;
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN 0;
  END IF;
  SELECT entity_type, erp_id INTO v_remote
    FROM public.bitrix24_assignment_remote
   WHERE bitrix_object = p_bitrix_object AND bitrix_id = p_bitrix_id
     AND (managed OR op_id IS NOT NULL);
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  RETURN public.bitrix24_assignment_touch(
    ARRAY[v_remote.entity_type], ARRAY[v_remote.erp_id], 'bitrix_inbound', p_ref_id, NULL, NULL);
END;
$$;

-- A changed user mapping re-checks everything its old and new ERP users are responsible for (in batches).
CREATE OR REPLACE FUNCTION public.bitrix24_assignment_enqueue_fanout(
  p_mapping_id bigint,
  p_erp_user_ids bigint[],
  p_actor_user_id bigint,
  p_correlation_id text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN NULL;
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO public.bitrix24_assignment_fanout (fanout_id, mapping_id, erp_user_ids, actor_user_id, correlation_id)
  VALUES (
    v_id,
    p_mapping_id,
    ARRAY(SELECT DISTINCT id FROM unnest(p_erp_user_ids) AS id WHERE id IS NOT NULL ORDER BY id),
    p_actor_user_id,
    p_correlation_id
  );
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bitrix24_assignment_order_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_types text[] := '{}';
  v_ids bigint[] := '{}';
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_types := v_types || ARRAY['order', 'client'];
    v_ids := v_ids || ARRAY[OLD.order_id::bigint, OLD.client_id::bigint];
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_types := v_types || ARRAY['order', 'client'];
    v_ids := v_ids || ARRAY[NEW.order_id::bigint, NEW.client_id::bigint];
  END IF;
  PERFORM public.bitrix24_assignment_touch(
    v_types,
    v_ids,
    'order_change',
    (CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END)::text,
    (CASE WHEN TG_OP = 'DELETE' THEN NULL WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.edited_by END)::bigint,
    NULL
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_order_insert_delete ON public.orders;
CREATE TRIGGER trg_bitrix24_assignment_order_insert_delete
  AFTER INSERT OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.bitrix24_assignment_order_changed();

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_order_update ON public.orders;
CREATE TRIGGER trg_bitrix24_assignment_order_update
  AFTER UPDATE OF manager_id, created_by, client_id, delete_flag, order_date, order_kind ON public.orders
  FOR EACH ROW
  WHEN (
    OLD.manager_id IS DISTINCT FROM NEW.manager_id
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.client_id IS DISTINCT FROM NEW.client_id
    OR OLD.delete_flag IS DISTINCT FROM NEW.delete_flag
    OR OLD.order_date IS DISTINCT FROM NEW.order_date
    OR OLD.order_kind IS DISTINCT FROM NEW.order_kind
  )
  EXECUTE FUNCTION public.bitrix24_assignment_order_changed();

CREATE OR REPLACE FUNCTION public.bitrix24_assignment_client_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN NULL;
  END IF;
  PERFORM public.bitrix24_assignment_touch(
    ARRAY['client'], ARRAY[NEW.client_id::bigint], 'client_change', NEW.client_id::text,
    (CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.edited_by END)::bigint, NULL);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_client_insert ON public.clients;
CREATE TRIGGER trg_bitrix24_assignment_client_insert
  AFTER INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.bitrix24_assignment_client_changed();

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_client_author ON public.clients;
CREATE TRIGGER trg_bitrix24_assignment_client_author
  AFTER UPDATE OF created_by ON public.clients
  FOR EACH ROW
  WHEN (OLD.created_by IS DISTINCT FROM NEW.created_by)
  EXECUTE FUNCTION public.bitrix24_assignment_client_changed();

-- A Bitrix24 object appeared, changed or became active for an order/client: an assignment waiting for it wakes up
-- without depending on the reverse sync.
CREATE OR REPLACE FUNCTION public.bitrix24_assignment_crm_mapping_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN NULL;
  END IF;
  IF NEW.entity_type NOT IN ('order', 'client') OR NEW.erp_id !~ '^[1-9][0-9]*$' THEN
    RETURN NULL;
  END IF;
  PERFORM public.bitrix24_assignment_touch(
    ARRAY[NEW.entity_type], ARRAY[NEW.erp_id::bigint], 'crm_mapping',
    NEW.bitrix_object || ':' || COALESCE(NEW.bitrix_id, '') || ':' || NEW.status, NULL, NULL);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_crm_mapping_insert ON public.crm_sync_mapping;
CREATE TRIGGER trg_bitrix24_assignment_crm_mapping_insert
  AFTER INSERT ON public.crm_sync_mapping
  FOR EACH ROW EXECUTE FUNCTION public.bitrix24_assignment_crm_mapping_changed();

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_crm_mapping_update ON public.crm_sync_mapping;
CREATE TRIGGER trg_bitrix24_assignment_crm_mapping_update
  AFTER UPDATE OF status, bitrix_id, bitrix_object ON public.crm_sync_mapping
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.bitrix_id IS DISTINCT FROM NEW.bitrix_id
    OR OLD.bitrix_object IS DISTINCT FROM NEW.bitrix_object
  )
  EXECUTE FUNCTION public.bitrix24_assignment_crm_mapping_changed();

-- An ERP user leaving (deactivated, made a service account) or coming back: everything they are responsible for is
-- re-checked, so their Bitrix24 account does not keep access to records ERP gave it.
CREATE OR REPLACE FUNCTION public.bitrix24_assignment_user_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mapping_id bigint;
BEGIN
  IF NOT public.bitrix24_assignment_active() THEN
    RETURN NULL;
  END IF;
  SELECT mapping_id INTO v_mapping_id
    FROM public.bitrix24_user_mapping
   WHERE erp_user_id = NEW.user_id AND is_active
   LIMIT 1;
  IF v_mapping_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.bitrix24_assignment_enqueue_fanout(
    v_mapping_id, ARRAY[NEW.user_id::bigint],
    COALESCE(NEW.edited_by::bigint, public.bitrix24_assignment_session_user()),
    COALESCE(NULLIF(current_setting('erp.request_id', true), ''), 'user:' || NEW.user_id || ':xact:' || txid_current()));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_bitrix24_assignment_user_eligibility ON public.users;
CREATE TRIGGER trg_bitrix24_assignment_user_eligibility
  AFTER UPDATE OF is_active, is_service_account ON public.users
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.is_service_account IS DISTINCT FROM NEW.is_service_account)
  EXECUTE FUNCTION public.bitrix24_assignment_user_changed();

COMMIT;
