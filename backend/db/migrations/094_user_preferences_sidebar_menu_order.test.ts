import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./094_user_preferences_sidebar_menu_order.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('094_user_preferences_sidebar_menu_order migration', () => {
  it('adds per-user sidebar menu order JSON preferences', () => {
    expect(sql).toMatch(/ALTER TABLE user_preferences/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS sidebar_menu_order JSONB NOT NULL DEFAULT '\{\}'::jsonb/i,
    );
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toMatch(
      /094_user_preferences_sidebar_menu_order\*\)\s*probe_all\s+"\$\(q_col user_preferences sidebar_menu_order\)"/,
    );
  });
});
