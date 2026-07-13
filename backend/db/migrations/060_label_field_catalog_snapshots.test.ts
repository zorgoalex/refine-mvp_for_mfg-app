import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./060_label_field_catalog_snapshots.sql', import.meta.url), 'utf8');

describe('060 label field catalog snapshots migration', () => {
  it('adds additive JSON snapshots for label and QR templates', () => {
    expect(sql).toMatch(/ALTER TABLE label_templates[\s\S]*ADD COLUMN IF NOT EXISTS field_catalog_snapshot JSONB NOT NULL/i);
    expect(sql).toMatch(/ALTER TABLE label_qr_templates[\s\S]*ADD COLUMN IF NOT EXISTS field_catalog_snapshot JSONB NOT NULL/i);
    expect(sql).toContain("jsonb_typeof(field_catalog_snapshot) = 'object'");
  });
});
