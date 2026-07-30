CREATE TABLE IF NOT EXISTS cut_result_archive_state (
  cut_job_id BIGINT NOT NULL,
  result_no INTEGER NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  PRIMARY KEY (cut_job_id, result_no),
  CONSTRAINT fk_cut_result_archive_state_job
    FOREIGN KEY (cut_job_id) REFERENCES cut_job(cut_job_id) ON DELETE RESTRICT,
  CONSTRAINT chk_cut_result_archive_state_result_no CHECK (result_no > 0)
);

CREATE INDEX IF NOT EXISTS idx_cut_result_archive_state_job
  ON cut_result_archive_state (cut_job_id, archived_at DESC);
