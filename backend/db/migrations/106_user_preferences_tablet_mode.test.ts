import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '106_user_preferences_tablet_mode.sql'),
  'utf8',
);
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('106 user preferences tablet mode migration', () => {
  it('adds a non-null per-user tablet override with a safe default', () => {
    expect(migration).toMatch(/ALTER TABLE user_preferences/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS tablet_mode BOOLEAN NOT NULL DEFAULT FALSE/i);
  });

  it('registers an exact end-state probe in the migration runner', () => {
    expect(runner).toMatch(
      /106_user_preferences_tablet_mode\*\)\s*probe_all\s+"\$\(q_col user_preferences tablet_mode\)"/,
    );
    expect(runner).toMatch(/\|106_\*(?:\||\))/);
  });
});
