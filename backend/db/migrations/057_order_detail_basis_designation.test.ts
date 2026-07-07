import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./057_order_detail_basis_designation.sql', import.meta.url), 'utf8');

describe('057_order_detail_basis_designation migration', () => {
  it('adds the nullable basis_designation field to order_details additively', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS basis_designation TEXT NULL/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });

  it('projects basis_designation through order_details_view without dropping siblings', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW order_details_view/i);
    expect(sql).toMatch(/od\.basis_project/i);
    expect(sql).toMatch(/od\.basis_data/i);
    expect(sql).toMatch(/od\.basis_designation/i);
    expect(sql).toMatch(/od\.basis_data,\s+od\.basis_designation/i);
    expect(sql).toMatch(/WHERE od\.delete_flag = false/i);
  });
});
