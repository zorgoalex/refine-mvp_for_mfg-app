import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./049_cut_pdf_template_layout.sql', import.meta.url), 'utf8');

describe('049_cut_pdf_template_layout migration', () => {
  it('adds a jsonb layout column to cut_pdf_templates', () => {
    expect(sql).toMatch(/ALTER TABLE cut_pdf_templates/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  });
});
