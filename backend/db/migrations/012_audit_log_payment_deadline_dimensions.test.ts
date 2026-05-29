import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./012_audit_log_payment_deadline_dimensions.sql', import.meta.url),
  'utf8',
);

describe('audit_log payment/deadline dimensions migration', () => {
  it('adds related_payment_id and related_deadline_id additively', () => {
    expect(migration).toMatch(/ALTER TABLE audit_log/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS related_payment_id BIGINT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS related_deadline_id BIGINT/i);
  });

  it('creates query indexes for the new dimensions', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_audit_log_related_payment_created_at/i,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_audit_log_related_deadline_created_at/i,
    );
  });

  it('is additive only (no destructive DDL)', () => {
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    expect(migration).not.toMatch(/ALTER\s+COLUMN/i);
  });
});
