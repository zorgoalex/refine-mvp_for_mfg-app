import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./084_user_preferences_ui_variant.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('084 user UI variant migration', () => {
  it('adds a legacy-defaulted, constrained per-user preference idempotently', () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS ui_variant TEXT NOT NULL DEFAULT 'legacy'/i,
    );
    expect(sql).toMatch(/ui_variant NOT IN \('legacy', 'evolution'\)/i);
    expect(sql).toMatch(/ALTER COLUMN ui_variant SET NOT NULL/i);
    expect(sql).toMatch(/chk_user_preferences_ui_variant/i);
    expect(sql).toMatch(/CHECK \(ui_variant IN \('legacy', 'evolution'\)\)/i);
  });

  it('lets auto migration mode detect the complete applied schema', () => {
    expect(runner).toMatch(
      /084_user_preferences_ui_variant\*\)\s*probe_all\s+"\$\(q_col user_preferences ui_variant\)"\s*"\$\(q_con chk_user_preferences_ui_variant\)"/,
    );
  });
});
