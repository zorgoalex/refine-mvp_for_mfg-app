import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('./115_vacuum_cut_numbering.sql', import.meta.url)),
  'utf8',
);

describe('115_vacuum_cut_numbering migration', () => {
  it('backfills resolvable vacuum bath cut numbers with the Cyrillic prefix', () => {
    expect(sql).toContain("SET source_bath_cut_number = 'В-' || candidate.cut_job_id::text || '-' || candidate.result_no::text");
    expect(sql).toContain("cj.last_calc_params->>'layout_mode'");
    expect(sql).toContain("profile.params->>'layout_mode'");
    expect(sql).toContain("cj.params->>'layout_mode'");
    expect(sql).toContain(") = 'vacuum_table'");
  });

  it('prefixes frozen legacy bath numbers and records the v2 marker', () => {
    expect(sql).toContain("source_bath_cut_number ~ '^[0-9]+-[0-9]+$'");
    expect(sql).toContain("'bazis-cut-bath-number-v2: frozen В-<cut job id>-<current result number>'");
  });
});
