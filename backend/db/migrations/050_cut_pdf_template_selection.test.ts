import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./050_cut_pdf_template_selection.sql', import.meta.url), 'utf8');

describe('050_cut_pdf_template_selection migration', () => {
  it('stores selected PDF template codes on cut jobs and cut groups', () => {
    expect(sql).toMatch(/ALTER TABLE cut_job/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pdf_template_code VARCHAR\(100\) NOT NULL DEFAULT 'standard'/i);
    expect(sql).toMatch(/ALTER TABLE cut_group/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pdf_template_code VARCHAR\(100\) NOT NULL DEFAULT 'standard'/i);
  });
});
