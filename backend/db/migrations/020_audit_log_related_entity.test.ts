import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Match the 017_* idiom: resolve relative to this module via import.meta.url.
const sql = readFileSync(new URL('./020_audit_log_related_entity.sql', import.meta.url), 'utf8');

describe('migration 020 audit_log_related_entity', () => {
  it('creates the bridge table referencing audit_log with cascade', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_log_related_entity/i);
    expect(sql).toMatch(/audit_id\s+UUID\s+NOT NULL\s+REFERENCES audit_log\s*\(audit_id\)\s+ON DELETE CASCADE/i);
    expect(sql).toMatch(/entity_type\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/entity_id\s+BIGINT\s+NOT NULL/i);
    expect(sql).toMatch(/PRIMARY KEY\s*\(audit_id,\s*entity_type,\s*entity_id\)/i);
  });
  it('indexes by (entity_type, entity_id) for related lookups', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_alre_entity\s+ON audit_log_related_entity\s*\(entity_type,\s*entity_id\)/i);
  });
  it('is additive only (no DROP/ALTER of audit_log)', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE audit_log\b/i);
  });
});
