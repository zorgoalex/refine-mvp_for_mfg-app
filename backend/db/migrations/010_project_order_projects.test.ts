import { readFileSync } from 'node:fs';
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
});
