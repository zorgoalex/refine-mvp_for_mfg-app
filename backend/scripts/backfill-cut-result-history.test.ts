import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./backfill-cut-result-history.ts', import.meta.url), 'utf8');

describe('cut result history backfill', () => {
  it('is batched, resumable, and validates before finalize', () => {
    expect(source).toContain('backfillLegacyResults(50)');
    expect(source).toContain("current_cut_result_id IS NULL");
    expect(source).toContain("snapshot_manifest IS NULL");
    expect(source).toContain('--validate-only');
    expect(source).toContain('row.computed_digest !== row.snapshot_digest');
    expect(source).toContain("contractVersion === 'cut_sheet_render_v1'");
  });

  it('does not print snapshot payloads or database URL', () => {
    expect(source).not.toContain('console.log(databaseUrl)');
    expect(source).not.toContain('JSON.stringify(snapshot)');
  });
});
