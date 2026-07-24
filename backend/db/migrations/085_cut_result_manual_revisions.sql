-- 085_cut_result_manual_revisions.sql
--
-- One operator-visible manual cut version may have several immutable save
-- revisions. The public result_no stays stable until a new automatic result is
-- calculated; revision_no is internal and preserves frozen history, label-map
-- projections, and command-ledger traceability.

BEGIN;

ALTER TABLE cut_result
  ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;

ALTER TABLE cut_result
  DROP CONSTRAINT uq_cut_result_job_no;

ALTER TABLE cut_result
  ADD CONSTRAINT uq_cut_result_job_no
  UNIQUE (cut_job_id, result_no, revision_no);

ALTER TABLE cut_result
  ADD CONSTRAINT chk_cut_result_revision_no
  CHECK (revision_no > 0);

CREATE INDEX idx_cut_result_job_no_revision
  ON cut_result (cut_job_id, result_no, revision_no DESC);

COMMIT;
