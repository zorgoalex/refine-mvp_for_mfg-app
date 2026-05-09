import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSchemaPreflight, getSchemaPreflightIssueCodes } from './preflight';

describe('schema preflight', () => {
  it('detects missing referenced tables', () => {
    const sql = 'CREATE UNIQUE INDEX idx_film_vendors ON film_vendors(ref_key_1c);';

    expect(getSchemaPreflightIssueCodes(sql)).toContain('FILM_VENDORS_TABLE_MISSING');
  });

  it('detects duplicate production status sort order with a unique constraint', () => {
    const sql = `
      CREATE TABLE production_statuses (
        production_status_id SMALLINT,
        sort_order SMALLINT NOT NULL,
        CONSTRAINT uq_production_statuses_sort_order UNIQUE (sort_order)
      );

      INSERT INTO production_statuses (sort_order, production_status_name, production_status_code, color) VALUES
        (10, 'New', 'new', '#000000'),
        (10, 'Drawn', 'drawn', '#000000')
      ON CONFLICT (production_status_name) DO NOTHING;
    `;

    expect(getSchemaPreflightIssueCodes(sql)).toContain(
      'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
    );
  });

  it('detects the known blockers in postgresql_schema_v_14.sql', () => {
    const schema = readFileSync(
      new URL('./fixtures/postgresql_schema_v_14.preflight.sql', import.meta.url),
      'utf8',
    );

    const issues = checkSchemaPreflight(schema);
    const codes = issues.map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'FILM_VENDORS_TABLE_MISSING',
        'ORDERS_ADD_CONSTRAINT_IN_CREATE_TABLE',
        'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
        'MUC_MATERIAL_ID_TYPE_MISMATCH',
        'ORR_EDGE_TYPE_ID_TYPE_MISMATCH',
        'ORR_SUPPLIER_ID_TYPE_MISMATCH',
        'ORR_UNIQUE_NULL_DUPLICATE_RISK',
        'AUDIT_LOG_TABLE_MISSING',
        'PAYMENT_STATUS_CODE_MISSING',
        'ROLES_CODE_UNIQUENESS_MISSING',
      ]),
    );

    expect(issues.filter((issue) => issue.severity === 'blocker').length).toBeGreaterThan(0);
  });
});
