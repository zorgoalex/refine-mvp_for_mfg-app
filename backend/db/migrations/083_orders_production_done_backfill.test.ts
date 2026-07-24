import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./083_orders_production_done_backfill.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(
  new URL('../../../ops/apply-migrations.sh', import.meta.url),
  'utf8',
);

describe('083 production Done backfill migration', () => {
  it('requires one unambiguous localized terminal status', () => {
    expect(sql).toMatch(/production_status_name\)\) IN \('done', 'завершено'\)/i);
    expect(sql).toMatch(/production_status_code\)\) ~ '\^\(done\|zaversheno\)\(_\|\$\)'/i);
    expect(sql).toContain("RAISE EXCEPTION 'Terminal production status Done/Завершено was not found'");
    expect(sql).toContain("RAISE EXCEPTION 'Terminal production status Done/Завершено is ambiguous");
  });

  it('forces every order older than one month into manual Done', () => {
    expect(sql).toMatch(/UPDATE orders o/i);
    expect(sql).toMatch(/created_at < CURRENT_TIMESTAMP - INTERVAL '1 month'/i);
    expect(sql).toMatch(/production_status_id = done_status_id/i);
    expect(sql).toMatch(/production_status_from_details_enabled = false/i);
    expect(sql).toMatch(/version = o\.version \+ 1/i);
    expect(sql).not.toMatch(/delete_flag\s*=/i);
  });

  it('is idempotent and classified by the migration runner', () => {
    expect(sql).toMatch(/IS DISTINCT FROM done_status_id/i);
    expect(sql).toMatch(/IS DISTINCT FROM false/i);
    expect(runner).toMatch(/083_orders_production_done_backfill\*\)\s*probe_true/);
    expect(runner).toMatch(/production_status_name\)\) IN \('done', 'завершено'\)/i);
    expect(runner).toMatch(/production_status_code\)\) ~ '\^\(done\|zaversheno\)\(_\|\$\)'/i);
  });
});
