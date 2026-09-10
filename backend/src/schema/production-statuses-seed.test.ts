import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSchemaPreflightIssueCodes } from './preflight';

// CI validates the versioned canonical snapshot. To validate a current external
// schema instead, explicitly supply ERP_CANONICAL_SCHEMA_PATH; read errors fail.
const schemaPath = process.env.ERP_CANONICAL_SCHEMA_PATH ??
  new URL('./fixtures/production-statuses-seed.v14.sql', import.meta.url);

// UNIQUE(sort_order) collisions abort the seed and break fresh provisioning.
describe('production_statuses seed (versioned snapshot or explicit external schema)', () => {
  it('seeds without violating UNIQUE(sort_order)', () => {
    const sql = readFileSync(schemaPath, 'utf8');
    expect(sql).toMatch(/INSERT\s+INTO\s+production_statuses\b/i);
    expect(sql).toMatch(
      /CONSTRAINT\s+uq_production_statuses_sort_order\s+UNIQUE\s*\(\s*sort_order\s*\)/i,
    );
    expect(getSchemaPreflightIssueCodes(sql)).not.toContain(
      'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
    );
  });
});
