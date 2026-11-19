import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '296_notification_balloon_slot.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 296: notification balloon slots', () => {
  it('is one bounded, additive transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    // The only DROP is the index of an earlier draft of this migration (stage), nothing else is dropped.
    expect(sql.replace('DROP INDEX IF EXISTS public.idx_notifications_balloon_slot_pending;', '')).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\s+public\.notifications\b/i);
    // Both columns are nullable, without a default (metadata-only ADD COLUMN).
    expect(sql).not.toMatch(/ADD COLUMN[^;]*(NOT NULL|DEFAULT)/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS balloon_slot text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS balloon_superseded_at timestamptz');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_notifications_balloon_slot_live');
    expect(sql).toContain('WHERE balloon_slot IS NOT NULL AND balloon_superseded_at IS NULL');
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_balloon_slot'/);
  });

  it('has an end-state probe of both columns, the check and the index', () => {
    const start = runner.indexOf('296_notification_balloon_slot*) probe_all');
    expect(start).toBeGreaterThan(0);
    const probe = runner.slice(start, runner.indexOf(';;', start));
    for (const part of ['q_col notifications balloon_slot', 'q_col notifications balloon_superseded_at',
      'q_con_on notifications chk_notifications_balloon_slot', 'q_idx idx_notifications_balloon_slot_live']) {
      expect(probe).toContain(part);
    }
    expect(runner).toMatch(/296_notification_balloon_slot\*\)\n\s+probe_file "\$f"/);
  });
});
