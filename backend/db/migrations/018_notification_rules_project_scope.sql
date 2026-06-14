-- Migration 018: project-scoped notification rules (additive)

ALTER TABLE notification_rules
  ADD COLUMN IF NOT EXISTS project_id UUID NULL
    REFERENCES public.project_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notification_rules_project_event
  ON notification_rules(project_id, event_type, is_enabled, priority)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_rules_global_event
  ON notification_rules(event_type, is_enabled, priority)
  WHERE project_id IS NULL;
