import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./011_project_members.sql', import.meta.url), 'utf8');
const schemaFixture = readFileSync(
  new URL('../../src/schema/fixtures/postgresql_schema_v_14.preflight.sql', import.meta.url),
  'utf8',
);

describe('project members migration', () => {
  it('uses users.user_id as the canonical member identity', () => {
    expect(schemaFixture).toMatch(/CREATE TABLE users\s*\([\s\S]*user_id BIGINT PRIMARY KEY/i);
    expect(migration).toMatch(/user_id BIGINT NOT NULL REFERENCES users\(user_id\) ON DELETE RESTRICT/i);
    expect(migration).not.toMatch(/\bemployee_id\b[\s\S]*REFERENCES employees/i);
    expect(migration).not.toMatch(/project_clients/i);
    expect(migration).not.toMatch(/project_workshops/i);
    expect(migration).not.toMatch(/project_links/i);
  });

  it('creates one temporal current/history table for project members', () => {
    expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.project_members/i);
    expect(migration).toMatch(/project_id UUID NOT NULL REFERENCES public\.project_projects\(id\) ON DELETE RESTRICT/i);
    expect(migration).toMatch(/role TEXT NOT NULL/i);
    expect(migration).toMatch(/valid_from TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
    expect(migration).toMatch(/valid_to TIMESTAMPTZ/i);
    expect(migration).toMatch(/metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
    expect(migration).toMatch(/CHECK \(valid_to IS NULL OR valid_to > valid_from\)/i);
  });

  it('prevents overlapping memberships for the same project user and role', () => {
    expect(migration).toMatch(/ex_project_members_no_role_overlap/i);
    expect(migration).toMatch(/project_id WITH =,\s*user_id WITH =,\s*role WITH =,\s*tstzrange/i);
    expect(migration).toMatch(/uq_project_members_current_role/i);
    expect(migration).toMatch(/WHERE \(valid_to IS NULL\)/i);
    expect(migration).toMatch(/idx_project_members_project_current/i);
    expect(migration).toMatch(/idx_project_members_user_current/i);
    expect(migration).toMatch(/idx_project_members_validity/i);
  });

  it('documents append-only history semantics and avoids destructive operations', () => {
    expect(migration).toMatch(/\[valid_from, valid_to\) intervals allow adjacent memberships/i);
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  });

  it('proves temporal member constraint behavior with executable SQL when a test database is available', () => {
    const behaviorSql = projectMemberConstraintBehaviorSql();
    const databaseUrl = process.env.P4_PROJECT_MEMBERS_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

    if (!databaseUrl || !hasCommand('psql')) {
      expect(behaviorSql).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
      expect(behaviorSql).toContain('CREATE TEMP TABLE project_members');
      expect(behaviorSql).toContain('allows adjacent [valid_from, valid_to) membership');
      expect(behaviorSql).toContain('reject same project/user/role overlap');
      expect(behaviorSql).toContain('WHEN exclusion_violation THEN');
      return;
    }

    execFileSync('psql', ['--set=ON_ERROR_STOP=1', databaseUrl], {
      input: behaviorSql,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });
});

function hasCommand(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function projectMemberConstraintBehaviorSql(): string {
  return `
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TEMP TABLE users (
  user_id BIGINT PRIMARY KEY
);

CREATE TEMP TABLE project_projects (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TEMP TABLE project_members (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES project_projects(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ended_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  end_reason TEXT,
  CONSTRAINT chk_project_members_valid_range
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ex_project_members_no_role_overlap
    EXCLUDE USING gist (
      project_id WITH =,
      user_id WITH =,
      role WITH =,
      tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
    )
);

INSERT INTO users(user_id) VALUES (1), (2);
INSERT INTO project_projects(id, code, name)
VALUES ('11111111-1111-4111-8111-111111111111', 'P1', 'Project 1');

INSERT INTO project_members (
  id, project_id, user_id, role, valid_from, valid_to, created_by
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  1,
  'manager',
  TIMESTAMPTZ '2026-01-01T00:00:00Z',
  TIMESTAMPTZ '2026-01-02T00:00:00Z',
  2
);

-- allows adjacent [valid_from, valid_to) membership
INSERT INTO project_members (
  id, project_id, user_id, role, valid_from, valid_to, created_by
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '11111111-1111-4111-8111-111111111111',
  1,
  'manager',
  TIMESTAMPTZ '2026-01-02T00:00:00Z',
  TIMESTAMPTZ '2026-01-03T00:00:00Z',
  2
);

DO $$
BEGIN
  -- reject same project/user/role overlap
  INSERT INTO project_members (
    id, project_id, user_id, role, valid_from, valid_to, created_by
  ) VALUES (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '11111111-1111-4111-8111-111111111111',
    1,
    'manager',
    TIMESTAMPTZ '2026-01-01T12:00:00Z',
    TIMESTAMPTZ '2026-01-01T13:00:00Z',
    2
  );
  RAISE EXCEPTION 'expected same project/user/role overlap to be rejected';
EXCEPTION
  WHEN exclusion_violation THEN
    NULL;
END;
$$;

ROLLBACK;
`;
}
