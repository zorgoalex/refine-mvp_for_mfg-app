import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '295_order_delivery_start_shift.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 295: order delivery and production start shift', () => {
  it('is one bounded transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('only adds nullable columns without defaults (metadata-only) and idempotent checks', () => {
    for (const column of ['delivery_method text', 'delivery_address text', 'delivery_notes text', 'start_shift smallint']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(sql).not.toMatch(/\bDEFAULT\b|\bNOT NULL\b|\bDROP\b|\bUPDATE public\.orders\b|\bDELETE\b/i);
    expect(sql).toContain("CHECK (delivery_method IS NULL OR delivery_method IN ('courier', 'pickup'))");
    expect(sql).toContain('CHECK (start_shift IS NULL OR start_shift BETWEEN 1 AND 3)');
    expect(sql).toContain('char_length(delivery_address) <= 500');
    expect(sql).toContain('char_length(delivery_notes) <= 1000');
    // Re-run safe: each constraint is added only when missing.
    expect(sql.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)).toHaveLength(4);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('295_order_delivery_start_shift*) probe_all');
    expect(runner).toMatch(/295_order_delivery_start_shift\*\)\n\s+probe_file "\$f"/);
  });

  it('probes every column and constraint the migration creates (a partial schema is not PRESENT)', () => {
    const start = runner.indexOf('295_order_delivery_start_shift*) probe_all');
    const probe = runner.slice(start, runner.indexOf(';;', start));
    const constraints = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((match) => match[1]);
    expect(constraints).toHaveLength(4);
    for (const name of constraints) expect(probe).toContain(`q_con_on orders ${name}`);
    for (const column of ['delivery_method', 'delivery_address', 'delivery_notes', 'start_shift']) {
      expect(probe).toContain(`q_col orders ${column}`);
    }
  });
});
