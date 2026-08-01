import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./093_cnc_telegram_svg_cut_import.sql', import.meta.url), 'utf8');

describe('093 CNC Telegram SVG cut import migration', () => {
  it('stores parsed SVG layout and links imported cut result to the same job', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS cut_layout_json JSONB/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS svg_cut_job_id BIGINT/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS svg_cut_result_id BIGINT/i);
    expect(sql).toMatch(/svg_cut_import_status IN \('none', 'skipped', 'needs_review', 'imported'\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(svg_cut_job_id, svg_cut_result_id\)\s+REFERENCES cut_result\(cut_job_id, cut_result_id\)/i);
    expect(sql).toMatch(/svg_cut_result_id IS NULL OR svg_cut_job_id IS NOT NULL/i);
  });
});
