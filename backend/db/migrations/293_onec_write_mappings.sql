-- ERP → 1C business commands, phase 1 (plan spec_erp/plans/1c-agent/2026-11-04-onec-business-commands-phase1-plan.md §8):
-- the mapping store that the commands use as a precondition, plus the permission to edit it.
--   onec_write_mappings — one ERP item (kind + erp_key) → a 1C ref (from the ETL mirror) and/or a fixed 1C value.
--   onec.write.mappings — edit these mappings (superadmin and admin by default; configurable in the roles matrix).
-- New objects only; nothing existing changes. Nothing is sent to 1C by this migration or by the mapping screen.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252/253/283).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

-- Unqualified like the other 1C tables (193…262), so the 1C integration tests can build it in an isolated schema.
-- Versions come from one sequence and are never reused, also after a clear and a re-create (optimistic edits stay safe).
CREATE SEQUENCE IF NOT EXISTS onec_write_mappings_version_seq;
CREATE TABLE IF NOT EXISTS onec_write_mappings (
  source_id   bigint      NOT NULL REFERENCES onec_sources (source_id),
  kind        text        NOT NULL,
  erp_key     text        NOT NULL,
  onec_ref    uuid,
  onec_value  jsonb,
  version     bigint      NOT NULL DEFAULT nextval('onec_write_mappings_version_seq'),
  updated_by  bigint      REFERENCES users (user_id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onec_write_mappings_pkey PRIMARY KEY (source_id, kind, erp_key),
  CONSTRAINT chk_onec_write_mappings_kind CHECK (kind IN (
    'order_status', 'shift_state', 'production_stage', 'workshop',
    'user_author', 'user_responsible', 'payment_type_account',
    'milling_nomenclature', 'mdf_nomenclature', 'delivery_nomenclature', 'remainder_nomenclature',
    'film_group')),
  CONSTRAINT chk_onec_write_mappings_erp_key CHECK (erp_key ~ '^[a-z_]+:[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT chk_onec_write_mappings_target CHECK (onec_ref IS NOT NULL OR onec_value IS NOT NULL),
  CONSTRAINT chk_onec_write_mappings_value CHECK (onec_value IS NULL OR jsonb_typeof(onec_value) = 'object'),
  CONSTRAINT chk_onec_write_mappings_version CHECK (version > 0)
);

COMMENT ON TABLE onec_write_mappings IS
  'ERP item → 1C ref/value used by ERP → 1C business commands; edited only through the backend (onec.write.mappings).';

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT 'onec.write.mappings', 'onec', '1С: связи для записи в 1С',
       'Сопоставить статусы, смены, этапы, цеха, пользователей, виды оплат и номенклатуру ERP с объектами 1С, по которым ERP будет создавать документы в 1С',
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + 1, false, true
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

DO $$
DECLARE
  granted jsonb := '{}'::jsonb;
  diff jsonb := '{}'::jsonb;
  role_ids integer[] := '{}';
  r record;
  version_before integer;
BEGIN
  FOR r IN
    WITH inserted AS (
      INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
      SELECT ro.role_id, 'onec.write.mappings', true
        FROM public.roles ro
       WHERE ro.role_code IN ('superadmin', 'admin')
      ON CONFLICT (role_id, permission_name) DO NOTHING
      RETURNING role_id
    )
    SELECT i.role_id, ro.role_code FROM inserted i JOIN public.roles ro USING (role_id) ORDER BY ro.role_code
  LOOP
    granted := granted || jsonb_build_object(r.role_code, jsonb_build_object('onec.write.mappings', true));
    diff := diff || jsonb_build_object('rolePermissions.' || r.role_code || '.onec.write.mappings',
                                       jsonb_build_object('from', false, 'to', true));
    role_ids := role_ids || r.role_id;
  END LOOP;

  IF cardinality(role_ids) = 0 THEN
    RETURN; -- all grants already present: nothing changes, nothing is audited
  END IF;

  SELECT version INTO version_before FROM public.permissions_state WHERE id = true;
  -- Tokens issued before the grant refresh their permissions.
  UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

  -- Same event and entity as a roles matrix save (writePermissionsAudit), actor = this migration.
  INSERT INTO public.audit_log (event, entity_type, entity_id, request_id, source, before_json, after_json, diff_json,
                                metadata_json)
  VALUES ('permissions.roles_matrix.update', 'role_permissions_matrix', 'all',
          'migration-293', 'migration',
          jsonb_build_object('rolePermissions', (SELECT jsonb_object_agg(k, jsonb_build_object('onec.write.mappings', false))
                                                   FROM jsonb_object_keys(granted) k)),
          jsonb_build_object('rolePermissions', granted),
          diff,
          jsonb_build_object('correlationId', 'migration-293', 'operation', 'onec_write_mappings_permission',
            'roleIds', to_jsonb(role_ids), 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;
