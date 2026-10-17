import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '256_doweling_order_version_triggers.sql'), 'utf8');

// Behaviour (one bump per transaction, link changes, no-op updates, cascade delete) is exercised on PostgreSQL by
// backend/src/modules/doweling/adapters/doweling-writes.integration.ts.
describe('migration 256: doweling order version triggers', () => {
  it('is one bounded transaction, additive and re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b/i);
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_doweling_orders_bump_version ON public.doweling_orders;');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_odl_bump_doweling_version ON public.order_doweling_links;');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(5);
    expect(sql).not.toContain('xmin');
  });

  it('bumps on a change of any column except version/updated_at/edited_by, unless the statement set the version', () => {
    expect(sql).toContain("(to_jsonb(NEW) - ARRAY['version', 'updated_at', 'edited_by'])");
    expect(sql).toContain('IF NEW.version IS DISTINCT FROM OLD.version THEN');
    expect(sql).toContain('BEFORE UPDATE ON public.doweling_orders');
    // Created in this transaction: linking it right away does not move the version.
    expect(sql).toContain('BEFORE INSERT ON public.doweling_orders');
  });

  it('a change of the active link set bumps the affected doweling orders at most once per transaction', () => {
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON public.order_doweling_links');
    expect(sql).toContain('(OLD.delete_flag, OLD.order_id, OLD.doweling_order_id)');
    expect(sql).toContain('AND NOT public.doweling_version_bumped_in_xact(d.doweling_order_id)');
    // Transaction-local mark: rolled back with a savepoint, not set by a no-op UPDATE.
    expect(sql).toContain("current_setting('erp.doweling_versions_bumped', true)");
    expect(sql).toMatch(/set_config\(\s*'erp\.doweling_versions_bumped',[\s\S]*?true\)/);
  });
});
