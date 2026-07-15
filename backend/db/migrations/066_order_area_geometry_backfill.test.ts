import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./066_order_area_geometry_backfill.sql', import.meta.url), 'utf8');

describe('066_order_area_geometry_backfill', () => {
  it('standard-rounds each stored detail area from raw geometry', () => {
    expect(sql).toMatch(/UPDATE order_details od/);
    expect(sql).toContain('od.height::numeric * od.width::numeric * od.quantity::numeric');
    expect(sql).toContain('/ 1000000');
    expect(sql).toMatch(/ROUND\([\s\S]*?,\s*2\s*\)/);
    expect(sql).toContain('IS DISTINCT FROM');
  });

  it('rounds the raw order geometry once instead of summing rounded detail areas', () => {
    expect(sql).toMatch(/UPDATE orders o/);
    expect(sql).toContain('SUM(source.area_mm2)');
    expect(sql).toContain('LEFT JOIN order_details');
    expect(sql).toMatch(/LEFT JOIN order_details od[\s\S]*?od\.delete_flag = false/);
    expect(sql).not.toMatch(/SUM\([^)]*od\.area/i);
  });

  it('contains no destructive schema or row removal operations', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE|DELETE FROM/i);
  });
});
