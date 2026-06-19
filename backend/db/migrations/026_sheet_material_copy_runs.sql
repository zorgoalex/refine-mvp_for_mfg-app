-- 026_sheet_material_copy_runs.sql
-- Additive ledger for the one-time SP2 materials -> sheet_material_types data copy.
-- Each write run records, in the SAME transaction as its copy/link writes, the rows it
-- created, the links it set, and operator/source/target provenance, so `reverse --run-id`
-- has a durable artifact AND the run is query/report-ready for "who/when/what/where"
-- (the audit substitute for this seed-class operation). Rollback: DROP TABLE.
CREATE TABLE IF NOT EXISTS sheet_material_copy_runs (
  run_id                          TEXT PRIMARY KEY,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor                           TEXT        NOT NULL,   -- operator identity (--actor / $SHEET_MATERIALS_COPY_ACTOR / OS user)
  source                          TEXT        NOT NULL,   -- 'sheet-materials-copy-runner'
  target_env                      TEXT        NOT NULL,   -- 'backend-test'
  db_user                         TEXT        NOT NULL,   -- current_user at write time
  database_name                   TEXT        NOT NULL,   -- current_database() at write time
  material_type_allowlist         SMALLINT[]  NOT NULL,
  created_sheet_material_type_ids BIGINT[]    NOT NULL,
  links                           JSONB       NOT NULL,   -- [{materialId, previousSheetMaterialTypeId, sheetMaterialTypeId}]
  reversed_at                     TIMESTAMPTZ NULL,
  reversed_by                     TEXT        NULL        -- actor of the reverse run
);
