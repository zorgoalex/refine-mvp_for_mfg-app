import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const precheckSql = readFileSync(
  new URL('./003_project_projects_precheck.sql', import.meta.url),
  'utf8',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('project projects DB precheck SQL', () => {
  it('is read-only for dry inspection', () => {
    const executableSql = stripSqlComments(precheckSql);

    expect(executableSql).toMatch(/\bSELECT\b/i);
    expect(executableSql).not.toMatch(
      /\b(ALTER|CREATE|UPDATE|DELETE|INSERT|DROP|TRUNCATE|REINDEX|VACUUM|GRANT|REVOKE|COMMENT)\b/i,
    );
  });

  it('checks project prerequisites, actual key types, and pgcrypto availability', () => {
    expect(precheckSql).toContain('project_required_tables');
    expect(precheckSql).toContain('project_pgcrypto_available');
    expect(precheckSql).toContain('project_users_user_id_type');
    expect(precheckSql).toContain('project_orders_order_id_type');
    expect(precheckSql).toContain('project_clients_client_id_type');
    expect(precheckSql).toContain('project_workshops_workshop_id_type');
    expect(precheckSql).toContain('project_order_workshops_fk_types');
    expect(precheckSql).toContain('project_core_existing_objects');
    expect(precheckSql).toContain('users_user_id_is_integer');
  });
});
