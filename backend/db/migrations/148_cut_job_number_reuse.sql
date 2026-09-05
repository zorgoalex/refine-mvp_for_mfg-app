BEGIN;

-- Keep historical numbers; only jobs that have not been deleted reserve them.
DROP INDEX IF EXISTS uq_cut_job_source_display_number;
CREATE UNIQUE INDEX uq_cut_job_source_display_number
  ON cut_job ((NULLIF(btrim(source_display_number), '')))
  WHERE status <> 'archived'
    AND NULLIF(btrim(source_display_number), '') IS NOT NULL;

ALTER TABLE cnc_telegram_import_items
  ADD COLUMN requested_cut_job_id BIGINT
    CONSTRAINT chk_cnc_tg_import_requested_number
    CHECK (requested_cut_job_id BETWEEN 1 AND 9007199254740991);

COMMENT ON COLUMN cnc_telegram_import_items.requested_cut_job_id IS
  'User-selected display number frozen at prepare; NULL means automatic numbering. Never a cut_job primary key.';

COMMIT;
