ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS texture_direction TEXT NOT NULL DEFAULT 'none'
    CHECK (texture_direction IN ('vertical', 'horizontal', 'none'));
