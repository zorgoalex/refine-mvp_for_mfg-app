import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const precheckSql = readFileSync(
  new URL('./002_deadline_engine_precheck.sql', import.meta.url),
  'utf8',
);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('deadline engine DB precheck SQL', () => {
  it('is read-only and suitable for DBeaver dry inspection', () => {
    const executableSql = stripSqlComments(precheckSql);

    expect(executableSql).not.toMatch(
      /\b(ALTER|CREATE|UPDATE|DELETE|INSERT|DROP|TRUNCATE|REINDEX|VACUUM|GRANT|REVOKE|COMMENT)\b/i,
    );
    expect(executableSql).toMatch(/\bSELECT\b/i);
  });

  it('checks deadline engine prerequisites and conflicting objects', () => {
    expect(precheckSql).toContain('deadline_required_tables');
    expect(precheckSql).toContain('deadline_pgcrypto_extension');
    expect(precheckSql).toContain('deadline_existing_objects');
    expect(precheckSql).toContain('deadline_order_workshops_columns');
    expect(precheckSql).toContain('deadline_orders_columns');
    expect(precheckSql).toContain('deadline_audit_log_columns');
  });
});
