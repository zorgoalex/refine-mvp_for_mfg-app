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

  it('checks only P1 prerequisites: users.user_id and pgcrypto availability', () => {
    expect(precheckSql).toContain('project_required_tables');
    expect(precheckSql).toContain('project_pgcrypto_available');
    expect(precheckSql).toContain('project_users_user_id_type');
    expect(precheckSql).toContain('users_user_id_is_bigint');
    expect(precheckSql).toContain('users_user_id_is_primary_key');
    expect(precheckSql).not.toMatch(/\borders\b/i);
    expect(precheckSql).not.toMatch(/\bclients\b/i);
    expect(precheckSql).not.toMatch(/\bworkshops\b/i);
    expect(precheckSql).not.toMatch(/\border_workshops\b/i);
    expect(precheckSql).not.toMatch(/\bproject_members\b/i);
    expect(precheckSql).not.toMatch(/\bproject_clients\b/i);
    expect(precheckSql).not.toMatch(/\bproject_workshops\b/i);
  });
});
