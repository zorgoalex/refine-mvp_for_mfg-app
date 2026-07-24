BEGIN;

CREATE TABLE IF NOT EXISTS deadline_default_schedule_config (
  config_id SMALLINT PRIMARY KEY DEFAULT 1,
  reserve_days INTEGER NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_default_schedule_singleton CHECK (config_id = 1),
  CONSTRAINT chk_deadline_default_schedule_reserve_days CHECK (
    reserve_days BETWEEN 0 AND 3650
  ),
  CONSTRAINT chk_deadline_default_schedule_version CHECK (version > 0),
  CONSTRAINT fk_deadline_default_schedule_updated_by
    FOREIGN KEY (updated_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

INSERT INTO deadline_default_schedule_config (config_id, reserve_days, version)
VALUES (1, 0, 1)
ON CONFLICT (config_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS deadline_default_stage_durations (
  production_status_id SMALLINT PRIMARY KEY,
  position INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  updated_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_default_stage_duration_days CHECK (
    duration_days BETWEEN 0 AND 3650
  ),
  CONSTRAINT chk_deadline_default_stage_position CHECK (position > 0),
  CONSTRAINT uq_deadline_default_stage_position UNIQUE (position),
  CONSTRAINT fk_deadline_default_stage_production_status
    FOREIGN KEY (production_status_id)
    REFERENCES production_statuses(production_status_id) ON DELETE RESTRICT,
  CONSTRAINT fk_deadline_default_stage_updated_by
    FOREIGN KEY (updated_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

COMMIT;
