import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSchemaPreflightIssueCodes } from './preflight';

// Slice-1 prerequisite for freecut cut-jobs: the canonical production_statuses
// seed must apply cleanly on a fresh database so cut eligibility config can
// reference real production_status ids. The table has UNIQUE(sort_order), so the
// seed must not repeat a sort_order value (a duplicate aborts the INSERT mid-seed
// and breaks fresh provisioning). See plan §2 / §15.
const CANONICAL_SCHEMA_PATH =
  '/home/ovhtest/projects/erp_dev/spec_erp/docs/reference/postgresql_schema_v_14.sql';

function readCanonicalSchema(): string {
  return readFileSync(CANONICAL_SCHEMA_PATH, 'utf8');
}

describe('production_statuses canonical seed (fresh-DB)', () => {
  it('seeds without violating UNIQUE(sort_order)', () => {
    const sql = readCanonicalSchema();

    // Sanity: we are actually looking at the production_statuses seed.
    expect(sql).toMatch(/INSERT\s+INTO\s+production_statuses\b/i);

    expect(getSchemaPreflightIssueCodes(sql)).not.toContain(
      'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
    );
  });
});
