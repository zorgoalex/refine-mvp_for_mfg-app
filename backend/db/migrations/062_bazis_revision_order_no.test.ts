import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./062_bazis_revision_order_no.sql', import.meta.url), 'utf8');

describe('062_bazis_revision_order_no migration', () => {
  it('exists and adds bazis_order_no additively with idempotent markers', () => {
    expect(sql).toMatch(/ALTER TABLE bazis_project_revisions/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS bazis_order_no text NULL/i);
    expect(sql).toMatch(/COMMENT ON COLUMN bazis_project_revisions\.bazis_order_no IS/i);
  });

  it('does not contain destructive operations', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
