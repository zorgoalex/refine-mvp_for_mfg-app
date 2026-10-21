-- Журнал дублей интеграций (D0): дела дублей справочников и записей ERP / Bitrix24 / 1С, их участники, история,
-- зависимости от наборов 1С, журнал запросов проверки (ставят триггеры справочников) и права экрана.
-- Additive: new tables, functions and enqueue triggers on the directory tables; orders and their details are not
-- touched. A trigger only appends one row to a table without unique keys or foreign keys — it never waits for a row
-- lock and never fails the write of the directory (an error is turned into a warning).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252/253).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE: all of them up front, failing at once instead of queueing behind writers.
LOCK TABLE public.clients, public.client_phones, public.suppliers, public.supplier_contacts, public.vendors,
           public.films, public.sheet_material_types, public.materials IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE IF NOT EXISTS public.integration_duplicate_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- The operator's switch of the enqueue triggers (independent of the search flag of the backend).
  enqueue_enabled boolean NOT NULL DEFAULT true,
  -- HMAC of a fixed text with the secret the keys of the cases were made with: another secret without a rotation of the
  -- keys would put new cases next to the old ones, so the search refuses to run with it.
  key_fingerprint bytea,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.integration_duplicate_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.integration_duplicate_cases (
  case_id bigserial PRIMARY KEY,
  rule_code text NOT NULL CHECK (rule_code ~ '^[a-z_]+\.[a-z0-9_]+$'),
  entity_kind text NOT NULL CHECK (entity_kind ~ '^[a-z_]+$'),
  -- HMAC-SHA256 of the rule and the normalized key with the server secret of this version; NULL once the data it came
  -- from is revoked or expired. Never the value itself.
  key_version smallint NOT NULL,
  key_hash bytea,
  key_mask text CHECK (key_mask IS NULL OR length(key_mask) <= 120),
  strength text NOT NULL CHECK (strength IN ('exact', 'likely')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'external', 'merged', 'resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  detected_via text NOT NULL CHECK (detected_via IN ('erp_manual', 'bitrix_inbound', 'onec_publication', 'catalog_import', 'order_import', 'scan')),
  detected_correlation_id text,
  resolved_at timestamptz,
  resolved_by bigint,
  resolution_code text CHECK (resolution_code IS NULL OR resolution_code ~ '^[a-z_]+$'),
  -- Why a user decided so: a fixed reason, never a free text (it could carry a phone or an IIN past the masks).
  resolution_reason text CHECK (resolution_reason IS NULL OR resolution_reason IN ('different_records', 'related_records', 'test_data', 'other')),
  -- The decision of a user, kept apart from the status: a case resolved because a member left for a while gets it back
  -- when the same members match again (only a record the case never had opens it).
  decision_status text CHECK (decision_status IS NULL OR decision_status IN ('dismissed', 'external')),
  decision_by bigint,
  decision_reason text CHECK (decision_reason IS NULL OR decision_reason IN ('different_records', 'related_records', 'test_data', 'other')),
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_integration_duplicate_cases_key CHECK ((key_hash IS NULL) = (key_mask IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_duplicate_cases_key
  ON public.integration_duplicate_cases (rule_code, key_version, key_hash) WHERE key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_integration_duplicate_cases_status
  ON public.integration_duplicate_cases (status, entity_kind, last_seen_at DESC);

-- A record taking part in a case. Only references: names and values are read live, by the rights of the reader.
CREATE TABLE IF NOT EXISTS public.integration_duplicate_members (
  case_id bigint NOT NULL REFERENCES public.integration_duplicate_cases (case_id) ON DELETE RESTRICT,
  system text NOT NULL CHECK (system ~ '^[a-z0-9_]+$'),
  entity_kind text NOT NULL CHECK (entity_kind ~ '^[a-z_]+$'),
  record_key text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 200),
  -- The ERP id of the record (a dimension for links); NULL for a record of another system.
  erp_entity_id bigint,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  record_created_at timestamptz,
  record_author_user_id bigint,
  record_author_external text CHECK (record_author_external IS NULL OR length(record_author_external) <= 200),
  record_via text NOT NULL CHECK (record_via IN ('erp_manual', 'bitrix_inbound', 'onec_publication', 'catalog_import', 'order_import', 'scan', 'unknown')),
  PRIMARY KEY (case_id, system, entity_kind, record_key)
);
CREATE INDEX IF NOT EXISTS ix_integration_duplicate_members_record
  ON public.integration_duplicate_members (system, entity_kind, record_key) WHERE left_at IS NULL;

-- The sets of 1C a key was read from (only sets with revocation and the personal data term).
CREATE TABLE IF NOT EXISTS public.integration_duplicate_case_sources (
  case_id bigint NOT NULL REFERENCES public.integration_duplicate_cases (case_id) ON DELETE RESTRICT,
  source_id bigint NOT NULL,
  entity_code text NOT NULL CHECK (entity_code IN ('counterparty_phones', 'counterparty_contacts')),
  snapshot_version timestamptz NOT NULL,
  PRIMARY KEY (case_id, source_id, entity_code)
);

CREATE TABLE IF NOT EXISTS public.integration_duplicate_events (
  event_id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES public.integration_duplicate_cases (case_id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('detected', 'member_joined', 'member_left', 'dismissed', 'marked_external',
                                         'reopened', 'resolved', 'source_refreshed', 'merged', 'merge_undone')),
  actor_user_id bigint,
  request_id text,
  correlation_id text,
  -- References, codes and counts only: never a value of a key.
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_integration_duplicate_events_case ON public.integration_duplicate_events (case_id, event_id);

-- Requests to check a record: appended by triggers and handlers, taken by the backend with a lease, deleted when done.
CREATE TABLE IF NOT EXISTS public.integration_duplicate_check_requests (
  request_id bigserial PRIMARY KEY,
  entity_kind text NOT NULL,
  system text NOT NULL,
  record_key text NOT NULL,
  via text NOT NULL,
  author_user_id bigint,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  leased_until timestamptz
);
CREATE INDEX IF NOT EXISTS ix_integration_duplicate_check_requests_free
  ON public.integration_duplicate_check_requests (leased_until NULLS FIRST, request_id);

CREATE TABLE IF NOT EXISTS public.integration_duplicate_check_failures (
  entity_kind text NOT NULL,
  system text NOT NULL,
  record_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  retry_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, system, record_key)
);

-- The state of the snapshot of one 1C set a value was read from: current (the same version), replaced (the set holds
-- another version), revoked, expired (older than the personal data term of the 1C module, PERSONAL_DATA_TTL_MS — a
-- test keeps the two equal) or missing. Versions compare to the millisecond.
CREATE OR REPLACE FUNCTION public.onec_entity_snapshot_state(p_source_id bigint, p_entity_code text, p_snapshot timestamptz)
RETURNS text AS $$
DECLARE
  s record;
BEGIN
  IF to_regclass('onec_etl_entity_state') IS NULL THEN RETURN 'missing'; END IF;
  SELECT revoked_at, snapshot_version INTO s FROM onec_etl_entity_state
   WHERE source_id = p_source_id AND entity_code = p_entity_code;
  IF NOT FOUND OR s.snapshot_version IS NULL THEN RETURN 'missing'; END IF;
  IF s.revoked_at IS NOT NULL THEN RETURN 'revoked'; END IF;
  IF p_snapshot < now() - interval '30 days' THEN RETURN 'expired'; END IF;
  IF date_trunc('milliseconds', s.snapshot_version) <> date_trunc('milliseconds', p_snapshot) THEN RETURN 'replaced'; END IF;
  RETURN 'current';
END;
$$ LANGUAGE plpgsql STABLE;

-- Enqueue trigger of a directory table. TG_ARGV[0] — the entity kind, TG_ARGV[1] — the column of the owner record.
-- Appends the new owner and, on delete or when the owner changes, the old one. Never fails the write.
CREATE OR REPLACE FUNCTION public.integration_duplicate_enqueue() RETURNS trigger AS $$
DECLARE
  kind text := TG_ARGV[0];
  owner_column text := TG_ARGV[1];
  new_owner text;
  old_owner text;
  via text;
  author bigint;
BEGIN
  BEGIN
    IF NOT COALESCE((SELECT enqueue_enabled FROM public.integration_duplicate_settings WHERE id), false) THEN
      RETURN NULL;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_owner := to_jsonb(NEW) ->> owner_column;
      author := COALESCE(NULLIF(to_jsonb(NEW) ->> 'edited_by', ''), NULLIF(to_jsonb(NEW) ->> 'updated_by', ''), NULLIF(to_jsonb(NEW) ->> 'created_by', ''))::bigint;
    END IF;
    IF TG_OP <> 'INSERT' THEN old_owner := to_jsonb(OLD) ->> owner_column; END IF;
    IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NULL; END IF;
    via := CASE
      WHEN public.crm_sync_is_bitrix_inbound() THEN 'bitrix_inbound'
      WHEN current_setting('erp.write_via', true) IN ('catalog_import', 'order_import', 'onec_publication') THEN current_setting('erp.write_via', true)
      ELSE 'erp_manual' END;
    IF new_owner IS NOT NULL THEN
      INSERT INTO public.integration_duplicate_check_requests (entity_kind, system, record_key, via, author_user_id)
      VALUES (kind, 'erp', new_owner, via, author);
    END IF;
    IF old_owner IS NOT NULL AND old_owner IS DISTINCT FROM new_owner THEN
      INSERT INTO public.integration_duplicate_check_requests (entity_kind, system, record_key, via, author_user_id)
      VALUES (kind, 'erp', old_owner, via, author);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'integration duplicates: check of % not queued: %', kind, SQLSTATE;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_integration_duplicates_clients ON public.clients;
CREATE TRIGGER trg_integration_duplicates_clients
  AFTER INSERT OR DELETE OR UPDATE OF client_name, is_active, ref_key_1c, person_type ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('client', 'client_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_client_phones ON public.client_phones;
CREATE TRIGGER trg_integration_duplicates_client_phones
  AFTER INSERT OR DELETE OR UPDATE OF phone_number, client_id ON public.client_phones
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('client', 'client_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_suppliers ON public.suppliers;
CREATE TRIGGER trg_integration_duplicates_suppliers
  AFTER INSERT OR DELETE OR UPDATE OF supplier_name, phone, is_active, ref_key_1c ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('supplier', 'supplier_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_supplier_contacts ON public.supplier_contacts;
CREATE TRIGGER trg_integration_duplicates_supplier_contacts
  AFTER INSERT OR DELETE OR UPDATE OF kind, value_normalized, origin, supplier_id ON public.supplier_contacts
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('supplier', 'supplier_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_vendors ON public.vendors;
CREATE TRIGGER trg_integration_duplicates_vendors
  AFTER INSERT OR DELETE OR UPDATE OF vendor_name, material_type_id, is_active, ref_key_1c ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('vendor', 'vendor_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_films ON public.films;
CREATE TRIGGER trg_integration_duplicates_films
  AFTER INSERT OR DELETE OR UPDATE OF film_name, vendor_id, is_active, canonical_film_id, ref_key_1c ON public.films
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('film', 'film_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_sheet_material_types ON public.sheet_material_types;
CREATE TRIGGER trg_integration_duplicates_sheet_material_types
  AFTER INSERT OR DELETE OR UPDATE OF name, thickness_mm, width_mm, height_mm, supplier_article, vendor_id, is_active, ref_key_1c
  ON public.sheet_material_types
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('sheet_material', 'sheet_material_type_id');

DROP TRIGGER IF EXISTS trg_integration_duplicates_materials ON public.materials;
CREATE TRIGGER trg_integration_duplicates_materials
  AFTER INSERT OR DELETE OR UPDATE OF material_name, is_active, is_sheet_shadow, ref_key_1c ON public.materials
  FOR EACH ROW EXECUTE FUNCTION public.integration_duplicate_enqueue('material', 'material_id');

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT v.permission_name, v.domain, v.label, v.description,
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + v.ord, false, true
  FROM (VALUES
    (1, 'integrations.duplicates.view', 'integrations', 'Интеграции: журнал дублей',
     'Раздел «Интеграции → Дубли»: дубли справочников ERP, Bitrix24 и 1С (полные значения — по правам источника)'),
    (2, 'integrations.duplicates.resolve', 'integrations', 'Интеграции: решения по дублям',
     'Отметить «Не дубль», «Исправить в 1С», открыть дело снова')
  ) AS v(ord, permission_name, domain, label, description)
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
      SELECT ro.role_id, p.permission_name, true
        FROM public.roles ro
        CROSS JOIN (VALUES ('integrations.duplicates.view'), ('integrations.duplicates.resolve')) AS p(permission_name)
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
          'migration-267', 'migration',
          jsonb_build_object('rolePermissions', before_json),
          jsonb_build_object('rolePermissions', granted),
          diff,
          jsonb_build_object('correlationId', 'migration-267', 'operation', 'integration_duplicates_permissions',
            'roleIds', to_jsonb(role_ids), 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;
