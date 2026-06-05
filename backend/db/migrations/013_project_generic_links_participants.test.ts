import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./013_project_generic_links_participants.sql', import.meta.url), 'utf8');

describe('013_project_generic_links_participants migration', () => {
  it('creates controlled entity registry and temporal links', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.project_entity_types');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.project_entity_links');
    expect(sql).toContain('entity_type_code TEXT NOT NULL REFERENCES public.project_entity_types(code)');
    expect(sql).toContain('CONSTRAINT chk_project_entity_links_valid_range');
    expect(sql).toContain('ex_project_entity_links_no_relation_overlap');
  });

  it('seeds only the accepted first entity allowlist', () => {
    for (const code of ['order', 'user', 'employee', 'client', 'workshop', 'deadline_instance']) {
      expect(sql).toContain(`('${code}'`);
    }

    expect(sql).not.toContain("('payment'");
    expect(sql).not.toContain("('any'");
  });

  it('creates participant roles and one-current-role participant contract', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.project_participant_roles');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.project_participants');
    expect(sql).toContain("participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'employee'))");
    expect(sql).toContain('chk_project_participants_participant_id_numeric');
    expect(sql).toContain('uq_project_participants_current_participant');

    for (const code of ['owner', 'manager', 'participant', 'observer']) {
      expect(sql).toContain(`('${code}'`);
    }
  });
});
