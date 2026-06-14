import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./018_notification_rules_project_scope.sql', import.meta.url),
  'utf8',
);

describe('018_notification_rules_project_scope migration', () => {
  it('adds nullable project_id to notification_rules with a project FK', () => {
    expect(sql).toMatch(
      /ALTER TABLE notification_rules\s+ADD COLUMN IF NOT EXISTS project_id UUID/i,
    );
    expect(sql).toMatch(/REFERENCES public\.project_projects\(id\)/i);
    expect(sql).toMatch(/ON DELETE SET NULL/i);
  });

  it('adds lookup indexes without mutating outbox or notifications', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_notification_rules_project_event/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_notification_rules_global_event/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+(outbox_events|notifications)/i);
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
  });
});
