import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./114_production_status_always_from_details.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('114_production_status_always_from_details migration', () => {
  it('materializes legacy manual order statuses before replacing recalc semantics', () => {
    const materializeIndex = sql.indexOf('UPDATE order_details od');
    const functionIndex = sql.indexOf('CREATE OR REPLACE FUNCTION recalc_order_production_status');

    expect(materializeIndex).toBeGreaterThanOrEqual(0);
    expect(functionIndex).toBeGreaterThan(materializeIndex);
    expect(sql).toContain('o.production_status_from_details_enabled IS DISTINCT FROM true');
    expect(sql).toContain('SET production_status_from_details_enabled = true');
  });

  it('removes the durable manual lock from recalc and guards trigger recursion with markers', () => {
    expect(sql).not.toContain('v_enabled');
    expect(sql).not.toContain('NEW.production_status_from_details_enabled = TRUE');
    expect(sql).toContain("current_setting('erp.order_status_to_details_sync', true)");
    expect(sql).toContain("set_config('erp.detail_status_to_order_recalc', 'on', true)");
    expect(sql).toContain("current_setting('erp.detail_status_to_order_recalc', true)");
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toMatch(/114_production_status_always_from_details\*\)\s*probe_all/);
    expect(runner).toContain('erp.order_status_to_details_sync');
    expect(runner).toContain('erp.detail_status_to_order_recalc');
  });
});
