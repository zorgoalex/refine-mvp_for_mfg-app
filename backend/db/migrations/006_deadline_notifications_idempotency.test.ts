import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./006_deadline_notifications_idempotency.sql', import.meta.url),
  'utf8',
);

describe('deadline notification idempotency migration', () => {
  it('adds idempotency and source indexes to notifications without rewriting existing rows', () => {
    expect(migration).toMatch(
      /ALTER TABLE notifications\s+ADD COLUMN IF NOT EXISTS idempotency_key TEXT/i,
    );
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_idempotency_key/i);
    expect(migration).toMatch(/ON notifications\s*\(idempotency_key\)/i);
    expect(migration).toMatch(/WHERE idempotency_key IS NOT NULL/i);
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_notifications_source/i);
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });
});
