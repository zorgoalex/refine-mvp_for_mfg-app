import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./009_project_projects.sql', import.meta.url), 'utf8');
const schemaFixture = readFileSync(
  new URL('../../src/schema/fixtures/postgresql_schema_v_14.preflight.sql', import.meta.url),
  'utf8',
);

describe('project projects migration', () => {
  it('locks project user foreign keys to the real users.user_id bigint type', () => {
    expect(schemaFixture).toMatch(/CREATE TABLE users\s*\([\s\S]*user_id BIGINT PRIMARY KEY/i);
    expect(migration).toMatch(/owner_user_id BIGINT REFERENCES users\(user_id\) ON DELETE SET NULL/i);
    expect(migration).toMatch(/created_by BIGINT REFERENCES users\(user_id\) ON DELETE SET NULL/i);
    expect(migration).not.toMatch(/owner_user_id INTEGER/i);
    expect(migration).not.toMatch(/created_by INTEGER/i);
  });

  it('creates only the public project_projects table for P1', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.project_projects/i);
    expect(migration).not.toMatch(/CREATE SCHEMA\s+project/i);
    expect(migration).not.toMatch(/project_members/i);
    expect(migration).not.toMatch(/project_clients/i);
    expect(migration).not.toMatch(/project_workshops/i);
    expect(migration).not.toMatch(/project_order/i);
  });

  it('checks pgcrypto availability before using gen_random_uuid', () => {
    expect(migration).toMatch(/pg_available_extensions[\s\S]+name = 'pgcrypto'/i);
    expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
    expect(migration).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  });

  it('adds project constraints and indexes without destructive operations', () => {
    expect(migration).toMatch(/status TEXT NOT NULL DEFAULT 'active'/i);
    expect(migration).toMatch(/CHECK \(status IN \('draft', 'active', 'paused', 'completed', 'archived'\)\)/i);
    expect(migration).toMatch(/metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
    expect(migration).toMatch(
      /CHECK \(code ~ '\^\[a-zA-Z0-9\]\[a-zA-Z0-9_-\]\{1,63\}\$'\)/i,
    );
    expect(migration).toMatch(/CHECK \(length\(btrim\(name\)\) BETWEEN 1 AND 256\)/i);
    expect(migration).toMatch(/CHECK \(ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at\)/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_project_projects_active_code/i);
    expect(migration).toMatch(/ON public\.project_projects \(lower\(btrim\(code\)\)\)/i);
    expect(migration).toMatch(/WHERE archived_at IS NULL/i);
    expect(migration).toMatch(/idx_project_projects_status/i);
    expect(migration).toMatch(/idx_project_projects_owner/i);
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  });
});
