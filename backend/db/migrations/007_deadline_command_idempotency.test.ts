import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('007_deadline_command_idempotency migration', () => {
  const sql = readFileSync(resolve(__dirname, '007_deadline_command_idempotency.sql'), 'utf8');

  it('adds a partial unique idempotency key for command-created deadlines', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS idempotency_key text');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS deadline_instances_idempotency_key_uidx');
    expect(sql).toContain('WHERE idempotency_key IS NOT NULL');
  });
});
