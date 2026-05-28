import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const precheckSql = readFileSync(
  new URL('./004_project_order_projects_precheck.sql', import.meta.url),
  'utf8',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('project order projects DB precheck SQL', () => {
  it('is read-only for dry inspection', () => {
    const executableSql = stripSqlComments(precheckSql);

    expect(executableSql).toMatch(/\bSELECT\b/i);
    expect(executableSql).not.toMatch(
      /\b(ALTER|CREATE|UPDATE|DELETE|INSERT|DROP|TRUNCATE|REINDEX|VACUUM|GRANT|REVOKE|COMMENT)\b/i,
    );
  });

  it('checks P3 prerequisites and temporal exclusion support', () => {
    expect(precheckSql).toContain('project_order_required_tables');
    expect(precheckSql).toContain('project_order_btree_gist_available');
    expect(precheckSql).toContain('project_order_orders_order_id_type');
    expect(precheckSql).toContain('orders_order_id_is_bigint');
    expect(precheckSql).toContain('project_order_users_user_id_type');
    expect(precheckSql).toContain('users_user_id_is_bigint');
    expect(precheckSql).toContain('project_order_adjacency_semantics');
    expect(precheckSql).toContain('[valid_from, valid_to)');
  });
});
