import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./124_roles_matrix.sql', import.meta.url), 'utf8');

describe('124_roles_matrix migration', () => {
  it('creates runtime RBAC tables additively and idempotently', () => {
    expect(sql).toMatch(/BEGIN;/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS permissions_catalog/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS role_permissions/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS role_policy_scopes/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS permissions_state/i);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
    expect(sql).toMatch(/COMMIT;/i);
  });

  it('keeps role permissions and scoped policy values constrained', () => {
    expect(sql).toMatch(/permission_name text PRIMARY KEY/i);
    expect(sql).toMatch(/role_id integer NOT NULL REFERENCES roles\(role_id\)/i);
    expect(sql).toMatch(/PRIMARY KEY \(role_id, permission_name\)/i);
    expect(sql).toMatch(/scope_value text NOT NULL CHECK \(scope_value IN \('all', 'own', 'assigned', 'none'\)\)/i);
    expect(sql).toMatch(/permissions_state_singleton CHECK \(id = true\)/i);
  });
});
