import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./071_user_preferences_recent_references.sql', import.meta.url),
  'utf8',
);

describe('071 recent reference preferences migration', () => {
  it('adds an object-shaped JSONB preference with a safe empty default', () => {
    expect(sql).toMatch(/ALTER TABLE user_preferences/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS recent_reference_entities JSONB NOT NULL DEFAULT '\{\}'::jsonb/i,
    );
  });
});
