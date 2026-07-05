import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./053_label_ocr_templates.sql', import.meta.url), 'utf8');

describe('053_label_ocr_templates migration', () => {
  it('creates the label_ocr_templates table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS label_ocr_templates/i);
    expect(sql).toMatch(/label_ocr_template_id bigserial PRIMARY KEY/i);
    expect(sql).toMatch(/name\s+text\s+NOT NULL/i);
  });

  it('includes jsonb columns for rules and sample_lines', () => {
    expect(sql).toMatch(/rules.*?jsonb.*?NOT NULL/is);
    expect(sql).toMatch(/sample_lines.*?jsonb.*?NOT NULL.*?DEFAULT.*?\[\]/is);
  });

  it('includes standard audit columns with user references', () => {
    expect(sql).toMatch(/is_active\s+boolean\s+NOT NULL DEFAULT true/i);
    expect(sql).toMatch(/version\s+integer\s+NOT NULL DEFAULT 1/i);
    expect(sql).toMatch(/created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
    expect(sql).toMatch(/created_by\s+bigint\s+REFERENCES users\(user_id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/updated_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
    expect(sql).toMatch(/updated_by\s+bigint\s+REFERENCES users\(user_id\) ON DELETE SET NULL/i);
  });

  it('adds a partial unique index on active templates by name', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS label_ocr_templates_name_active_uniq/i);
    expect(sql).toMatch(/ON label_ocr_templates \(lower\(name\)\) WHERE is_active/i);
  });
});
