-- 020_audit_log_related_entity.sql
-- Normalized many-to-many bridge for audit_log related entities (users, employees, etc.).
-- Additive only.
CREATE TABLE IF NOT EXISTS audit_log_related_entity (
  audit_id    UUID NOT NULL REFERENCES audit_log(audit_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id   BIGINT NOT NULL,
  PRIMARY KEY (audit_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_alre_entity
  ON audit_log_related_entity (entity_type, entity_id);
