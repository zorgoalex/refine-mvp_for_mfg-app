import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./003_orders_view_order_name_numeric_guard.sql', import.meta.url),
  'utf8',
);

describe('orders_view order_name_numeric guard migration', () => {
  it('recreates orders_view with int4 overflow protection', () => {
    expect(migration).toMatch(/CREATE OR REPLACE VIEW orders_view/i);
    expect(migration).toContain('order_name_numeric');
    expect(migration).toContain('order_name_digits.value::BIGINT > 2147483647');
    expect(migration).toContain('order_name_digits.value::INTEGER');
  });

  it('extracts digits once with a lateral value and keeps the view shape stable', () => {
    expect(migration).toMatch(/CROSS JOIN LATERAL/i);
    expect(migration).toContain("regexp_replace(COALESCE(ord.order_name, ''), '\\D', '', 'g')");
    expect(migration).toContain('ord.manager_id');
    expect(migration).toContain('ord.created_by');
    expect(migration).toContain('ord.updated_at');
  });
});
