-- Объединение клиентов (D1 журнала дублей): операции объединения, их журнал для отмены, перенаправления объединённых
-- клиентов на остающихся, сторожа, которые не дают записать ссылку на объединённого клиента, право `clients.merge`.
-- Additive: new tables and functions; guard triggers on the tables that reference a client (they refuse nothing while
-- there are no redirects); the Bitrix request invariant also accepts the mapping of a merged client for its survivor.
-- No row of orders, projects or clients is changed.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252/253/267).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE: all of them up front, failing at once instead of queueing behind writers.
LOCK TABLE public.clients, public.orders, public.projects, public.client_phones, public.client_contacts,
           public.deadline_instances, public.bitrix24_incoming_request, public.crm_sync_mapping
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE IF NOT EXISTS public.client_merges (
  merge_id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES public.integration_duplicate_cases (case_id),
  survivor_id bigint NOT NULL REFERENCES public.clients (client_id),
  merged_id bigint NOT NULL REFERENCES public.clients (client_id),
  status text NOT NULL CHECK (status IN ('done', 'undone')),
  actor_user_id bigint NOT NULL,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  -- What moved, was deleted or skipped, by table: counts only, never a value.
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_at timestamptz NOT NULL DEFAULT now(),
  undo_until timestamptz NOT NULL,
  undone_at timestamptz,
  undone_by bigint,
  undo_request_id text,
  -- What came back and what was skipped (with reasons): ids and counts only.
  undo_report jsonb,
  -- The personal data of the journal (phones, contact values, notes) was erased: the merge can no longer be undone.
  journal_purged_at timestamptz,
  CONSTRAINT chk_client_merges_parties CHECK (survivor_id <> merged_id),
  CONSTRAINT chk_client_merges_undone CHECK ((status = 'undone') = (undone_at IS NOT NULL))
);
-- One standing merge for a merged client.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_merges_merged_done ON public.client_merges (merged_id) WHERE status = 'done';
CREATE INDEX IF NOT EXISTS ix_client_merges_survivor ON public.client_merges (survivor_id, merged_at DESC);
CREATE INDEX IF NOT EXISTS ix_client_merges_merged ON public.client_merges (merged_id, merged_at DESC);
CREATE INDEX IF NOT EXISTS ix_client_merges_case ON public.client_merges (case_id);
CREATE INDEX IF NOT EXISTS ix_client_merges_purge ON public.client_merges (undo_until) WHERE journal_purged_at IS NULL;

-- Every change of a merge, for its undo. `before`/`after` of phones and contacts hold personal data until the term of the
-- undo ends (then they are replaced by {"purged": true}); the other kinds hold ids, versions and client ids only.
CREATE TABLE IF NOT EXISTS public.client_merge_items (
  merge_id bigint NOT NULL REFERENCES public.client_merges (merge_id),
  item_no integer NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN (
    'project', 'order', 'phone_moved', 'phone_deleted', 'phone_key_moved', 'phone_primary',
    'contact_moved', 'contact_deleted', 'contact_primary', 'onec_link', 'redirect_repointed')),
  row_id text NOT NULL,
  before jsonb,
  after jsonb,
  PRIMARY KEY (merge_id, item_no),
  CONSTRAINT chk_client_merge_items_row_id CHECK (row_id ~ '^[0-9]+$')
);

-- A merged client points to the client it lives on in (always the last one: chains are kept flat).
CREATE TABLE IF NOT EXISTS public.client_merge_redirects (
  merged_client_id bigint PRIMARY KEY REFERENCES public.clients (client_id),
  survivor_id bigint NOT NULL REFERENCES public.clients (client_id),
  merge_id bigint NOT NULL REFERENCES public.client_merges (merge_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_client_merge_redirects_parties CHECK (merged_client_id <> survivor_id)
);
CREATE INDEX IF NOT EXISTS ix_client_merge_redirects_survivor ON public.client_merge_redirects (survivor_id);

-- A reference to a client written while a merge of that client runs waits for the merge (the merge holds the client
-- FOR UPDATE), and after its COMMIT sees the redirect: a new snapshot for each statement of a VOLATILE function in READ
-- COMMITTED. A reference to a merged client is refused — for every writer, Hasura and imports included.
CREATE OR REPLACE FUNCTION public.client_merge_guard() RETURNS trigger AS $$
DECLARE
  v_survivor bigint;
BEGIN
  IF NEW.client_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.clients WHERE client_id = NEW.client_id FOR KEY SHARE;
  SELECT survivor_id INTO v_survivor FROM public.client_merge_redirects WHERE merged_client_id = NEW.client_id;
  IF FOUND THEN
    RAISE EXCEPTION 'client % is merged into client %', NEW.client_id, v_survivor
      USING ERRCODE = '23514', CONSTRAINT = 'chk_client_not_merged',
            DETAIL = format('merged_client_id=%s survivor_id=%s', NEW.client_id, v_survivor);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_merge_guard_orders ON public.orders;
CREATE TRIGGER trg_client_merge_guard_orders
  BEFORE INSERT OR UPDATE OF client_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.client_merge_guard();

DROP TRIGGER IF EXISTS trg_client_merge_guard_projects ON public.projects;
CREATE TRIGGER trg_client_merge_guard_projects
  BEFORE INSERT OR UPDATE OF client_id ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.client_merge_guard();

DROP TRIGGER IF EXISTS trg_client_merge_guard_client_phones ON public.client_phones;
CREATE TRIGGER trg_client_merge_guard_client_phones
  BEFORE INSERT OR UPDATE OF client_id ON public.client_phones
  FOR EACH ROW EXECUTE FUNCTION public.client_merge_guard();

DROP TRIGGER IF EXISTS trg_client_merge_guard_client_contacts ON public.client_contacts;
CREATE TRIGGER trg_client_merge_guard_client_contacts
  BEFORE INSERT OR UPDATE OF client_id ON public.client_contacts
  FOR EACH ROW EXECUTE FUNCTION public.client_merge_guard();

DROP TRIGGER IF EXISTS trg_client_merge_guard_bitrix24_incoming_request ON public.bitrix24_incoming_request;
CREATE TRIGGER trg_client_merge_guard_bitrix24_incoming_request
  BEFORE INSERT OR UPDATE OF client_id ON public.bitrix24_incoming_request
  FOR EACH ROW EXECUTE FUNCTION public.client_merge_guard();

-- Only a deadline without an order: the client of a deadline of an order is a copy taken from the order (and aligned
-- after a merge); a lock of the client inside the deadline paths would meet the order locks of the deadline worker.
DROP TRIGGER IF EXISTS trg_client_merge_guard_deadline_instances ON public.deadline_instances;
CREATE TRIGGER trg_client_merge_guard_deadline_instances
  BEFORE INSERT OR UPDATE OF client_id, order_id ON public.deadline_instances
  FOR EACH ROW WHEN (NEW.order_id IS NULL AND NEW.client_id IS NOT NULL)
  EXECUTE FUNCTION public.client_merge_guard();

-- A merged client comes back only by the undo of its merge (which deletes the redirect first): it cannot be made
-- active again nor linked to a 1C counterparty while the redirect stands.
CREATE OR REPLACE FUNCTION public.client_merge_clients_guard() RETURNS trigger AS $$
DECLARE
  v_survivor bigint;
BEGIN
  IF (NEW.is_active AND NOT OLD.is_active)
     OR (NEW.ref_key_1c IS NOT NULL AND NEW.ref_key_1c IS DISTINCT FROM OLD.ref_key_1c) THEN
    SELECT survivor_id INTO v_survivor FROM public.client_merge_redirects WHERE merged_client_id = OLD.client_id;
    IF FOUND THEN
      RAISE EXCEPTION 'client % is merged into client %', OLD.client_id, v_survivor
        USING ERRCODE = '23514', CONSTRAINT = 'chk_client_not_merged',
              DETAIL = format('merged_client_id=%s survivor_id=%s', OLD.client_id, v_survivor);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_merge_guard_clients ON public.clients;
CREATE TRIGGER trg_client_merge_guard_clients
  BEFORE UPDATE OF is_active, ref_key_1c ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.client_merge_clients_guard();

-- The Bitrix request invariant (migration 145): an active or converted request needs an exact active mapping of its
-- client to its counterparty. A deal made on the contact of a merged client after the merge belongs to the survivor,
-- while its counterparty is still the contact of the merged client: that mapping is accepted for the survivor.
CREATE OR REPLACE FUNCTION public.client_merge_mapping_erp_ids(p_client_id bigint) RETURNS SETOF text AS $$
  SELECT p_client_id::text
  UNION ALL
  SELECT r.merged_client_id::text FROM public.client_merge_redirects r WHERE r.survivor_id = p_client_id
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.validate_bitrix24_incoming_request_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  r bitrix24_incoming_request%ROWTYPE;
  o orders%ROWTYPE;
  v_order_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
    SELECT * INTO r
    FROM bitrix24_incoming_request
    WHERE linked_order_id = v_order_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    r := NEW;
  END IF;

  IF r.state = 'unresolved' AND r.linked_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'unresolved Bitrix request cannot link order'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_state_link';
  END IF;

  IF r.linked_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO o FROM orders WHERE order_id = r.linked_order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF o.source_system <> 'bitrix24'
     OR r.client_id IS DISTINCT FROM o.client_id
     OR (r.state = 'active' AND o.order_kind <> 'crm_request')
     OR (r.state = 'converted' AND o.order_kind <> 'production_order') THEN
    RAISE EXCEPTION 'Bitrix request % does not match linked order %', r.request_id, o.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_linked_order';
  END IF;

  IF r.state IN ('active', 'converted') AND (
    r.counterparty_object_type IS NULL
    OR r.counterparty_bitrix_id IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM crm_sync_mapping mapping
       WHERE mapping.entity_type = 'client'
         AND mapping.erp_id IN (SELECT public.client_merge_mapping_erp_ids(r.client_id))
         AND mapping.bitrix_object = r.counterparty_object_type
         AND mapping.bitrix_id = r.counterparty_bitrix_id
         AND mapping.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'Bitrix request % lacks exact active client mapping', r.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_client_mapping';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_bitrix24_request_client_mappings()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  invalid_request_id BIGINT;
BEGIN
  SELECT request.request_id INTO invalid_request_id
    FROM bitrix24_incoming_request request
   WHERE request.state IN ('active', 'converted')
     AND NOT EXISTS (
       SELECT 1
         FROM crm_sync_mapping mapping
        WHERE mapping.entity_type = 'client'
          AND mapping.erp_id IN (SELECT public.client_merge_mapping_erp_ids(request.client_id))
          AND mapping.bitrix_object = request.counterparty_object_type
          AND mapping.bitrix_id = request.counterparty_bitrix_id
          AND mapping.status = 'active'
     )
   ORDER BY request.request_id
   LIMIT 1;
  IF invalid_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bitrix request % lacks exact active client mapping', invalid_request_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_client_mapping';
  END IF;
  RETURN NULL;
END;
$function$;

-- A change of the redirects (an undo restoring older ones, a chain made flat) is checked against the same invariant at
-- COMMIT: a request left without its mapping rolls the change back.
DROP TRIGGER IF EXISTS ctrg_client_merge_redirects_bitrix_requests ON public.client_merge_redirects;
CREATE CONSTRAINT TRIGGER ctrg_client_merge_redirects_bitrix_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.client_merge_redirects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_bitrix24_request_client_mappings();

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT 'clients.merge', 'clients', 'Клиенты: объединение дублей',
       'Соединить двух клиентов из журнала дублей (заказы, группы, телефоны, контакты и связь с 1С переходят к остающемуся) и отменить объединение',
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + 1, true, true
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

DO $$
DECLARE
  granted jsonb := '{}'::jsonb;
  before_json jsonb := '{}'::jsonb;
  diff jsonb := '{}'::jsonb;
  role_ids integer[] := '{}';
  r record;
  version_before integer;
BEGIN
  FOR r IN
    WITH inserted AS (
      INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
      SELECT ro.role_id, 'clients.merge', true
        FROM public.roles ro
       WHERE ro.role_code IN ('superadmin', 'admin', 'top_manager')
      ON CONFLICT (role_id, permission_name) DO NOTHING
      RETURNING role_id, permission_name
    )
    SELECT i.role_id, i.permission_name, ro.role_code FROM inserted i JOIN public.roles ro USING (role_id)
     ORDER BY ro.role_code, i.permission_name
  LOOP
    granted := jsonb_set(granted, ARRAY[r.role_code], COALESCE(granted -> r.role_code, '{}'::jsonb) || jsonb_build_object(r.permission_name, true));
    before_json := jsonb_set(before_json, ARRAY[r.role_code], COALESCE(before_json -> r.role_code, '{}'::jsonb) || jsonb_build_object(r.permission_name, false));
    diff := diff || jsonb_build_object('rolePermissions.' || r.role_code || '.' || r.permission_name,
                                       jsonb_build_object('from', false, 'to', true));
    IF NOT r.role_id = ANY (role_ids) THEN role_ids := role_ids || r.role_id; END IF;
  END LOOP;

  IF cardinality(role_ids) = 0 THEN
    RETURN; -- all grants already present: nothing changes, nothing is audited
  END IF;

  SELECT version INTO version_before FROM public.permissions_state WHERE id = true;
  UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

  INSERT INTO public.audit_log (event, entity_type, entity_id, request_id, source, before_json, after_json, diff_json,
                                metadata_json)
  VALUES ('permissions.roles_matrix.update', 'role_permissions_matrix', 'all',
          'migration-268', 'migration',
          jsonb_build_object('rolePermissions', before_json),
          jsonb_build_object('rolePermissions', granted),
          diff,
          jsonb_build_object('correlationId', 'migration-268', 'operation', 'client_merge_permissions',
            'roleIds', to_jsonb(role_ids), 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;
