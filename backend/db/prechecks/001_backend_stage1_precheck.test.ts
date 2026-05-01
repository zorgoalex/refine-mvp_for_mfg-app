import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const precheckSql = readFileSync(
  new URL('./001_backend_stage1_precheck.sql', import.meta.url),
  'utf8',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('backend stage 1 DB precheck SQL', () => {
  it('is read-only and suitable for DBeaver dry inspection', () => {
    const executableSql = stripSqlComments(precheckSql);

    expect(executableSql).not.toMatch(
      /\b(ALTER|CREATE|UPDATE|DELETE|INSERT|DROP|TRUNCATE|REINDEX|VACUUM|GRANT|REVOKE|COMMENT)\b/i,
    );
    expect(executableSql).toMatch(/\bSELECT\b/i);
  });

  it('checks the known migration risk areas', () => {
    expect(precheckSql).toContain('roles_duplicate_role_code');
    expect(precheckSql).toContain('Canonical superadmin role check');
    expect(precheckSql).toContain('users_with_role_id_2');
    expect(precheckSql).toContain('r.role_code');
    expect(precheckSql).toContain('payment_status_unmapped_name');
    expect(precheckSql).toContain('orders_final_amount_inconsistent');
    expect(precheckSql).toContain('orr_duplicate_active_material');
    expect(precheckSql).toContain('production_statuses_duplicate_sort_order');
    expect(precheckSql).toContain('backend_stage1_existing_objects');
  });
});
