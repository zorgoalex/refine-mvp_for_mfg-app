import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./017_audit_log_related_user_dimension.sql', import.meta.url),
  'utf8',
);

describe('audit_log related_user_id dimension migration', () => {
  it('adds related_user_id additively', () => {
    expect(migration).toMatch(/ALTER TABLE audit_log/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS related_user_id BIGINT/i);
  });

  it('indexes related_user_id for query-by-user reporting', () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_audit_log_related_user_created_at/i);
    expect(migration).toMatch(/ON audit_log\(related_user_id, created_at DESC\)/i);
  });

  it('is additive only (no destructive DDL)', () => {
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    expect(migration).not.toMatch(/ALTER\s+COLUMN/i);
  });
});
