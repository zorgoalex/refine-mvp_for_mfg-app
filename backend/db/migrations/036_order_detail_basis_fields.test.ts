import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./036_order_detail_basis_fields.sql', import.meta.url), 'utf8');

describe('036_order_detail_basis_fields migration', () => {
  it('adds nullable Basis fields to order_details additively', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS basis_project TEXT NULL/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS basis_data TEXT NULL/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });

  it('projects Basis fields through order_details_view', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW order_details_view/i);
    expect(sql).toMatch(/od\.basis_project/i);
    expect(sql).toMatch(/od\.basis_data/i);
    expect(sql).toMatch(/JOIN orders ord\s+ON ord\.order_id = od\.order_id AND ord\.delete_flag = false/i);
    expect(sql).toMatch(/WHERE od\.delete_flag = false/i);
  });
});
