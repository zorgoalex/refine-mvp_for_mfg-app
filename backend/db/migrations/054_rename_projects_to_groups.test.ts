import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./054_rename_projects_to_groups.sql', import.meta.url), 'utf8');

describe('054_rename_projects_to_groups migration', () => {
  it('renames all 7 tables project_*→group_*', () => {
    for (const [from, to] of [
      ['project_projects', 'group_groups'],
      ['project_order_projects', 'group_order_groups'],
      ['project_members', 'group_members'],
      ['project_entity_types', 'group_entity_types'],
      ['project_entity_links', 'group_entity_links'],
      ['project_participant_roles', 'group_participant_roles'],
      ['project_participants', 'group_participants'],
    ]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE (public\\.)?${from} RENAME TO ${to}`, 'i'));
    }
  });

  it('renames project_id columns to group_id (incl. notification_rules)', () => {
    expect(sql).toMatch(/ALTER TABLE (public\.)?group_order_groups RENAME COLUMN project_id TO group_id/i);
    expect(sql).toMatch(/ALTER TABLE (public\.)?notification_rules RENAME COLUMN project_id TO group_id/i);
  });

  it('renames constraints, indexes, trigger, function', () => {
    expect(sql).toMatch(/ALTER TABLE (public\.)?group_groups RENAME CONSTRAINT chk_project_projects_status TO chk_group_groups_status/i);
    expect(sql).toMatch(/ALTER INDEX (public\.)?uq_project_projects_active_code RENAME TO uq_group_groups_active_code/i);
    expect(sql).toMatch(/ALTER TRIGGER project_projects_updated_at ON (public\.)?group_groups RENAME TO group_groups_updated_at/i);
    expect(sql).toMatch(/ALTER FUNCTION (public\.)?project_projects_set_updated_at\(\) RENAME TO group_groups_set_updated_at/i);
  });

  it('renames auto-generated FK constraint names (test-referenced)', () => {
    expect(sql).toMatch(/RENAME CONSTRAINT project_projects_owner_user_id_fkey TO group_groups_owner_user_id_fkey/i);
    expect(sql).toMatch(/RENAME CONSTRAINT project_order_projects_project_id_fkey TO group_order_groups_group_id_fkey/i);
    expect(sql).toMatch(/RENAME CONSTRAINT notification_rules_project_id_fkey TO notification_rules_group_id_fkey/i);
  });

  it('does NOT touch deadline scope_type CHECK (documented boundary)', () => {
    expect(sql).not.toMatch(/chk_deadline_policies_scope_type/i);
  });

  it('migrates notification_rules resolver + rule_code data', () => {
    expect(sql).toMatch(/UPDATE notification_rules SET resolvers[\s\S]*project_participants[\s\S]*group_participants/i);
    expect(sql).toMatch(/RENAME COLUMN project_id TO group_id/i);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;/);
    expect(sql).toMatch(/COMMIT;\s*$/);
  });
});
