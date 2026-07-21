import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./081_user_preferences_page_sizes.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('081 page-size preferences migration', () => {
  it('adds an object-shaped JSONB preference with a safe empty default', () => {
    expect(sql).toMatch(/ALTER TABLE user_preferences/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS page_size_preferences JSONB NOT NULL DEFAULT '\{\}'::jsonb/i,
    );
  });

  it('lets auto migration mode detect an already-applied schema', () => {
    expect(runner).toMatch(
      /081_\*\)\s*probe_all\s+"\$\(q_col user_preferences page_size_preferences\)"/,
    );
  });
});
