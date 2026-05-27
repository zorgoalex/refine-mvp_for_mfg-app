import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./010_project_order_projects.sql', import.meta.url), 'utf8');
const schemaFixture = readFileSync(
  new URL('../../src/schema/fixtures/postgresql_schema_v_14.preflight.sql', import.meta.url),
  'utf8',
);

describe('project order projects migration', () => {
  it('uses the real integer orders.order_id type', () => {
    expect(schemaFixture).toMatch(/CREATE TABLE orders\s*\([\s\S]*order_id INTEGER PRIMARY KEY/i);
    expect(migration).toMatch(/order_id INTEGER NOT NULL REFERENCES orders\(order_id\) ON DELETE CASCADE/i);
    expect(migration).not.toMatch(/order_id UUID/i);
    expect(migration).not.toMatch(/order_id BIGINT/i);
  });

  it('locks project audit user foreign keys to the real users.user_id bigint type', () => {
    expect(schemaFixture).toMatch(/CREATE TABLE users\s*\([\s\S]*user_id BIGINT PRIMARY KEY/i);
    expect(migration).toMatch(/created_by BIGINT REFERENCES users\(user_id\) ON DELETE SET NULL/i);
    expect(migration).toMatch(/ended_by BIGINT REFERENCES users\(user_id\) ON DELETE SET NULL/i);
    expect(migration).not.toMatch(/created_by INTEGER/i);
    expect(migration).not.toMatch(/ended_by INTEGER/i);
  });

  it('creates temporal project order links with relation and range constraints', () => {
    expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.project_order_projects/i);
    expect(migration).toMatch(/project_id UUID NOT NULL REFERENCES public\.project_projects\(id\) ON DELETE RESTRICT/i);
    expect(migration).toMatch(/relation_type TEXT NOT NULL DEFAULT 'main'/i);
    expect(migration).toMatch(/CHECK \(relation_type IN \('main', 'secondary', 'reporting', 'billing', 'derived'\)\)/i);
    expect(migration).toMatch(/CHECK \(valid_to IS NULL OR valid_to > valid_from\)/i);
    expect(migration).toMatch(/metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  });

  it('prevents overlapping duplicate relation and same-order primary intervals', () => {
    expect(migration).toMatch(/EXCLUDE USING gist/i);
    expect(migration).toMatch(/order_id WITH =,\s*project_id WITH =,\s*relation_type WITH =,\s*tstzrange/i);
    expect(migration).toMatch(/WHERE \(valid_to IS NULL\)/i);
    expect(migration).toMatch(/WHERE \(is_primary\)/i);
    expect(migration).toMatch(/uq_project_order_projects_current_relation/i);
    expect(migration).toMatch(/uq_project_order_projects_current_primary/i);
  });

  it('documents adjacent range behavior and avoids destructive operations', () => {
    expect(migration).toMatch(/\[valid_from, valid_to\) intervals allow adjacent links/i);
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  });

  it('proves btree_gist temporal constraint behavior with executable SQL when a test database is available', () => {
    const behaviorSql = projectOrderConstraintBehaviorSql();
    const databaseUrl = process.env.P3_PROJECT_ORDER_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

    if (!databaseUrl || !hasCommand('psql')) {
      expect(behaviorSql).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
      expect(behaviorSql).toContain('CREATE TEMP TABLE project_order_projects');
      expect(behaviorSql).toContain('adjacent [valid_from, valid_to) interval');
      expect(behaviorSql).toContain('reject same order/project/relation overlap');
      expect(behaviorSql).toContain('reject same-order primary overlap');
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

function projectOrderConstraintBehaviorSql(): string {
  return `
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TEMP TABLE users (
  user_id BIGINT PRIMARY KEY
);

CREATE TEMP TABLE orders (
  order_id INTEGER PRIMARY KEY,
  delete_flag BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TEMP TABLE project_projects (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TEMP TABLE project_order_projects (
  id UUID PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES project_projects(id) ON DELETE RESTRICT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  relation_type TEXT NOT NULL DEFAULT 'main',
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ended_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  end_reason TEXT,
  CONSTRAINT chk_project_order_projects_relation_type
    CHECK (relation_type IN ('main', 'secondary', 'reporting', 'billing', 'derived')),
  CONSTRAINT chk_project_order_projects_valid_range
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ex_project_order_projects_no_relation_overlap
    EXCLUDE USING gist (
      order_id WITH =,
      project_id WITH =,
      relation_type WITH =,
      tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
    ),
  CONSTRAINT ex_project_order_projects_one_primary_overlap
    EXCLUDE USING gist (
      order_id WITH =,
      tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
    )
    WHERE (is_primary)
);

INSERT INTO users(user_id) VALUES (1);
INSERT INTO orders(order_id) VALUES (1001);
INSERT INTO project_projects(id, code, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'P1', 'Project 1'),
  ('22222222-2222-4222-8222-222222222222', 'P2', 'Project 2');

INSERT INTO project_order_projects (
  id, order_id, project_id, is_primary, relation_type, valid_from, valid_to, created_by
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  1001,
  '11111111-1111-4111-8111-111111111111',
  true,
  'main',
  TIMESTAMPTZ '2026-01-01T00:00:00Z',
  TIMESTAMPTZ '2026-01-02T00:00:00Z',
  1
);

-- allows adjacent [valid_from, valid_to) interval for same order/project/relation
INSERT INTO project_order_projects (
  id, order_id, project_id, is_primary, relation_type, valid_from, valid_to, created_by
) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  1001,
  '11111111-1111-4111-8111-111111111111',
  true,
  'main',
  TIMESTAMPTZ '2026-01-02T00:00:00Z',
  TIMESTAMPTZ '2026-01-03T00:00:00Z',
  1
);

DO $$
BEGIN
  -- reject same order/project/relation overlap
  INSERT INTO project_order_projects (
    id, order_id, project_id, is_primary, relation_type, valid_from, valid_to, created_by
  ) VALUES (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    1001,
    '11111111-1111-4111-8111-111111111111',
    false,
    'main',
    TIMESTAMPTZ '2026-01-01T12:00:00Z',
    TIMESTAMPTZ '2026-01-01T13:00:00Z',
    1
  );
  RAISE EXCEPTION 'expected same order/project/relation overlap to be rejected';
EXCEPTION
  WHEN exclusion_violation THEN
    NULL;
END;
$$;

DO $$
BEGIN
  -- reject same-order primary overlap
  INSERT INTO project_order_projects (
    id, order_id, project_id, is_primary, relation_type, valid_from, valid_to, created_by
  ) VALUES (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    1001,
    '22222222-2222-4222-8222-222222222222',
    true,
    'secondary',
    TIMESTAMPTZ '2026-01-01T12:00:00Z',
    TIMESTAMPTZ '2026-01-01T13:00:00Z',
    1
  );
  RAISE EXCEPTION 'expected same-order primary overlap to be rejected';
EXCEPTION
  WHEN exclusion_violation THEN
    NULL;
END;
$$;

ROLLBACK;
`;
}
