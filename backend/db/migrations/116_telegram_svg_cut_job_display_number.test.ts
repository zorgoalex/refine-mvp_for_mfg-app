import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('./116_telegram_svg_cut_job_display_number.sql', import.meta.url)),
  'utf8',
);

describe('116_telegram_svg_cut_job_display_number migration', () => {
  it('adds source_display_number and backfills Telegram SVG imported cut jobs', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS source_display_number TEXT');
    expect(sql).toContain('packet.svg_cut_job_id AS cut_job_id');
    expect(sql).toContain('packet.cutting_sequence_no::text AS source_display_number');
    expect(sql).toContain("packet.svg_cut_import_status = 'imported'");
    expect(sql).toContain("job.selection_criteria->>'source' = 'cnc_telegram_svg'");
  });
});
