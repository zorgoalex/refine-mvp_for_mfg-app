import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '258_financial_projections.sql'), 'utf8');
const rules = JSON.parse(readFileSync(resolve(__dirname, '../../../ops/hasura/access-predicates.json'), 'utf8'));

function viewColumns(name: string): string[] {
  const body = sql.split(`CREATE OR REPLACE VIEW public.${name} AS`)[1]?.split(';')[0] ?? '';
  const select = body.split(/\n\s*FROM /)[0].replace(/^\s*SELECT/, '');
  return select.split(',').map((part) => part.trim().split(/\s+/).pop()!.split('.').pop()!);
}

describe('migration 258: money projections for Hasura (access groups «финансы»)', () => {
  it('is one bounded transaction that locks permissions_state first', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const lock = sql.indexOf('FROM public.permissions_state WHERE id = true FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf('ALTER TABLE public.permissions_state'));
  });

  it('adds the financials state (open by default; closed by step F2; reverting during its revert)', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS hasura_financials_state text NOT NULL DEFAULT 'open'");
    expect(sql).toContain("CHECK (hasura_financials_state IN ('open', 'closed', 'reverting'))");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS hasura_financials_users jsonb');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS hasura_financials_revert jsonb');
  });

  it('creates exactly the projections of the metadata rules, with their columns, from the base tables', () => {
    const projections = rules.financials.projections as Record<string, { columns: string[] }>;
    expect(Object.keys(projections).sort()).toEqual(['doweling_order_financials_view', 'order_detail_financials_view', 'order_financials_view']);
    for (const [name, projection] of Object.entries(projections)) {
      expect(viewColumns(name)).toEqual(projection.columns);
    }
    expect(sql).toContain('FROM public.orders ord');
    expect(sql).toContain('FROM public.order_details od');
    expect(sql).toContain('FROM public.doweling_orders d');
  });

  it('every money column a step F2 removes from a source is served by its projection', () => {
    const { sources, projections } = rules.financials as {
      sources: Record<string, { projection: string; financialColumns: string[] }>;
      projections: Record<string, { columns: string[] }>;
    };
    for (const [name, source] of Object.entries(sources)) {
      for (const column of source.financialColumns) {
        expect(projections[source.projection].columns, `${name}.${column}`).toContain(column);
      }
    }
  });
});
