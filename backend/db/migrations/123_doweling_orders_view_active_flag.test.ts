import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./123_doweling_orders_view_active_flag.sql', import.meta.url), 'utf8');
const runner = readFileSync(resolve(process.cwd(), 'ops/apply-migrations.sh'), 'utf8');

describe('123_doweling_orders_view_active_flag migration', () => {
  it('exposes inactive doweling rows and the active flag to the UI', () => {
    expect(sql).toContain('d.delete_flag');
    expect(sql).not.toContain('WHERE d.delete_flag = false');
  });

  it('keeps order data attached only through active links and active orders', () => {
    expect(sql).toContain('AND odl.delete_flag = false');
    expect(sql).toContain('AND ord.delete_flag = false');
    expect(sql).toContain('ord.order_id');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('123_doweling_orders_view_active_flag*) probe_all');
    expect(runner).toContain("table_name = 'doweling_orders_view'");
    expect(runner).toContain("column_name = 'delete_flag'");
    expect(runner).toMatch(/122_\*\|123_\*/);
  });
});
