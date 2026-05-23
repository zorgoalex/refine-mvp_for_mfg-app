import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./006_deadline_notifications_idempotency.sql', import.meta.url),
  'utf8',
);

function getStatement(name: RegExp): string {
  const statement = migration
    .split(';')
    .find((candidate) => name.test(candidate));

  expect(statement).toBeDefined();

  return `${statement};`;
}

describe('deadline notification idempotency migration', () => {
  it('adds idempotency and source indexes to notifications without rewriting existing rows', () => {
    const idempotencyColumnStatement = getStatement(
      /ALTER TABLE notifications\s+ADD COLUMN IF NOT EXISTS idempotency_key\b/i,
    );
    const sourceIndexStatement = getStatement(/CREATE INDEX IF NOT EXISTS idx_notifications_source/i);

    expect(idempotencyColumnStatement).toMatch(
      /ALTER TABLE notifications\s+ADD COLUMN IF NOT EXISTS idempotency_key TEXT\s*;/i,
    );
    expect(idempotencyColumnStatement).not.toMatch(/\bNOT\s+NULL\b/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_idempotency_key/i);
    expect(migration).toMatch(/ON notifications\s*\(idempotency_key\)/i);
    expect(migration).toMatch(/WHERE idempotency_key IS NOT NULL/i);
    expect(sourceIndexStatement).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_notifications_source\s+ON notifications\s*\(\s*source_type\s*,\s*source_id\s*,\s*created_at DESC\s*\)\s*;/i,
    );
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });
});
