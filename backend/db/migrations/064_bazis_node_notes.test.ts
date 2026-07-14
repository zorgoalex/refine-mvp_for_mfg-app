import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./064_bazis_node_notes.sql', import.meta.url), 'utf8');

describe('064_bazis_node_notes migration', () => {
  it('exists and adds notes additively with idempotent markers', () => {
    expect(sql).toMatch(/ALTER TABLE bazis_nodes/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS notes text NULL/i);
    expect(sql).toMatch(/COMMENT ON COLUMN bazis_nodes\.notes IS/i);
  });

  it('does not contain destructive operations', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
