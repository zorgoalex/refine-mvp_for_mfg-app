import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const precheckSql = readFileSync(
  new URL('./005_project_members_precheck.sql', import.meta.url),
  'utf8',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('project members DB precheck SQL', () => {
  it('is read-only for dry inspection', () => {
    const executableSql = stripSqlComments(precheckSql);

    expect(executableSql).toMatch(/\bSELECT\b/i);
    expect(executableSql).not.toMatch(
      /\b(ALTER|CREATE|UPDATE|DELETE|INSERT|DROP|TRUNCATE|REINDEX|VACUUM|GRANT|REVOKE|COMMENT)\b/i,
    );
  });

  it('checks P4 prerequisites without introducing client workshop or generic links tables', () => {
    expect(precheckSql).toContain('project_members_required_tables');
    expect(precheckSql).toContain('project_members_btree_gist_available');
    expect(precheckSql).toContain('project_members_users_user_id_type');
    expect(precheckSql).toContain('users_user_id_is_bigint');
    expect(precheckSql).toContain('project_members_project_id_type');
    expect(precheckSql).toContain('project_members_adjacency_semantics');
    expect(precheckSql).toContain('[valid_from, valid_to)');
    expect(precheckSql).toContain('project_members_forbidden_tables_absent');
    expect(precheckSql).toContain('project_clients');
    expect(precheckSql).toContain('project_workshops');
    expect(precheckSql).toContain('project_links');
  });
});
