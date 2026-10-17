import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Production runs with backend permissions (the money right is enforced); the default of the test env is the legacy login.
vi.mock('../config/featureFlags', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/featureFlags')>();
  return { ...original, featureFlags: { ...original.featureFlags, useBackendPermissions: true } };
});
import {
  financialFieldPath,
  flattenFinancials,
  hasHasuraFinancials,
  HASURA_FINANCIAL_FIELDS,
  selectionWithFinancials,
} from './hasuraFinancials';

const rules = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/access-predicates.json'), 'utf8'));
const withRight = { permissions: ['orders.view', 'orders.view_financials'] } as const;
const withoutRight = { permissions: ['orders.view'] } as const;

describe('Hasura money through `financials` (access groups «финансы»)', () => {
  it('mirrors the money columns of the metadata rules (step F2 removes exactly these)', () => {
    const fromRules = Object.fromEntries(
      Object.entries(rules.financials.sources as Record<string, { financialColumns: string[] }>)
        .map(([name, source]) => [name, [...source.financialColumns].sort()]),
    );
    const fromFrontend = Object.fromEntries(Object.entries(HASURA_FINANCIAL_FIELDS).map(([name, fields]) => [name, [...fields].sort()]));
    expect(fromFrontend).toEqual(fromRules);
  });

  it('never selects a money column on the row; asks `financials` only with orders.view_financials', () => {
    const fields = ['doweling_order_id', 'doweling_order_name', 'total_amount', 'final_amount', 'payment_status_name'];
    const own = selectionWithFinancials('doweling_orders_view', fields, withoutRight);
    expect(own).toEqual(['doweling_order_id', 'doweling_order_name']);
    expect(selectionWithFinancials('doweling_orders_view', fields, withRight)).toEqual([
      'doweling_order_id', 'doweling_order_name', 'financials { payment_status_name total_amount final_amount }',
    ]);
    expect(selectionWithFinancials('materials', ['material_id', 'total_amount'], withoutRight)).toEqual(['material_id', 'total_amount']);
  });

  it('order details bring money only when the call asks for it (meta.financials); orders and doweling by default', () => {
    const fields = ['detail_id', 'area', 'detail_cost', 'milling_cost_per_sqm'];
    expect(selectionWithFinancials('order_details', fields, withRight)).toEqual(['detail_id', 'area']);
    expect(selectionWithFinancials('order_details', fields, withRight, { financials: true })).toEqual([
      'detail_id', 'area', 'financials { milling_cost_per_sqm detail_cost }',
    ]);
    expect(selectionWithFinancials('order_details', fields, withoutRight, { financials: true })).toEqual(['detail_id', 'area']);
    expect(selectionWithFinancials('orders_view', ['order_id', 'final_amount'], withRight)).toEqual(['order_id', 'financials { final_amount }']);
    expect(selectionWithFinancials('doweling_orders', ['doweling_order_id', 'final_amount'], withRight)).toEqual([
      'doweling_order_id', 'financials { final_amount }',
    ]);
  });

  it('puts the money back on the row; without the right the money is absent (never a 0)', () => {
    expect(flattenFinancials('orders_view', { order_id: 1, financials: { final_amount: 900, paid_amount: 0 } }))
      .toEqual({ order_id: 1, final_amount: 900, paid_amount: 0 });
    const hidden = flattenFinancials('orders_view', { order_id: 1, financials: null }) as Record<string, unknown>;
    expect(hidden).toEqual({ order_id: 1 });
    expect('final_amount' in hidden).toBe(false);
  });

  it('a form may send money only when it arrived (readiness)', () => {
    const money = Object.fromEntries(HASURA_FINANCIAL_FIELDS.doweling_orders.map((field) => [field, null]));
    expect(hasHasuraFinancials('doweling_orders', { doweling_order_id: 1, ...money })).toBe(true);
    expect(hasHasuraFinancials('doweling_orders', { doweling_order_id: 1 })).toBe(false);
    expect(hasHasuraFinancials('doweling_orders', undefined)).toBe(false);
  });

  it('sorts / filters a money field through `financials`, drops it without the right, leaves other fields alone', () => {
    expect(financialFieldPath('doweling_orders_view', 'final_amount', withRight)).toBe('financials');
    expect(financialFieldPath('doweling_orders_view', 'final_amount', withoutRight)).toBeNull();
    expect(financialFieldPath('doweling_orders_view', 'doweling_order_id', withoutRight)).toBeUndefined();
  });
});

describe('order detail money is asked for where a Hasura path shows it (flags off)', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('the data provider passes meta to the selection of getList, getOne and getMany', () => {
    const provider = read('src/utils/dataProvider.ts');
    expect(provider.match(/const selection = fieldsFor\(resource, meta\);/g)?.length).toBe(3);
    expect(provider).toContain('getOne: async ({ resource, id, meta }');
    expect(provider).toContain('getMany: async ({ resource, ids, meta }');
  });

  it.each([
    ['src/pages/orders/show.tsx', 2],
    ['src/pages/orders/list.tsx', 1],
    ['src/pages/orders/components/OrderForm.tsx', 1],
    ['src/hooks/useOrderSave.ts', 1],
    ['src/hooks/useOrderExport.ts', 2],
  ])('%s asks for money on its legacy reads', (path, count) => {
    expect(read(path).match(/meta: \{ financials: true \}/g)?.length ?? 0).toBeGreaterThanOrEqual(count);
  });
});
