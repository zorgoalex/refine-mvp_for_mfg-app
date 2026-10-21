import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoUnclosedHasuraNarrowing, HASURA_UNCLOSED_PERMISSIONS } from './hasura-unclosed-permissions';

const matrix = (grants: Record<string, Record<string, boolean>>) => ({
  roles: [
    { roleId: 2, roleCode: 'manager' },
    { roleId: 3, roleCode: 'operator' },
  ],
  rolePermissions: grants,
});

describe('PERMISSION_NARROWING_BLOCKED (access groups 0Б, «финансы»)', () => {
  it('refuses to take orders.view_financials away from a role while Hasura still serves the financial columns', () => {
    const before = matrix({ '2': { 'orders.view_financials': true, 'orders.view': true } });
    const next = matrix({ '2': { 'orders.view_financials': false, 'orders.view': true } });

    expect(() => assertNoUnclosedHasuraNarrowing(before, next, true)).toThrow(
      expect.objectContaining({
        statusCode: 422,
        code: 'PERMISSION_NARROWING_BLOCKED',
        details: expect.objectContaining({ blocked: [expect.objectContaining({ roleId: '2', roleCode: 'manager', permission: 'orders.view_financials' })] }),
      }),
    );
  });

  it('allows granting it, keeping it and changing permissions whose Hasura paths are closed', () => {
    expect(() =>
      assertNoUnclosedHasuraNarrowing(
        matrix({ '3': { 'orders.view_financials': false, 'clients.view': true } }),
        matrix({ '3': { 'orders.view_financials': true, 'clients.view': false } }),
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoUnclosedHasuraNarrowing(
        matrix({ '2': { 'orders.view_financials': true } }),
        matrix({ '2': { 'orders.view_financials': true } }),
        true,
      ),
    ).not.toThrow();
  });

  it('refuses every narrowing while Hasura does not follow the effective permissions (before step B, after a revert)', () => {
    const scoped = (grants: Record<string, boolean>, scopes: Record<string, string>) => ({ ...matrix({ '2': grants }), roleScopes: { '2': scopes } });
    expect(() => assertNoUnclosedHasuraNarrowing(
      scoped({ 'clients.view': true }, { 'orders.view': 'all' }),
      scoped({ 'clients.view': false }, { 'orders.view': 'all' }), false,
    )).toThrow(expect.objectContaining({ code: 'PERMISSION_NARROWING_BLOCKED', details: expect.objectContaining({ hasuraFollowsPermissions: false }) }));
    expect(() => assertNoUnclosedHasuraNarrowing(
      scoped({ 'clients.view': true }, { 'orders.view': 'all' }),
      scoped({ 'clients.view': true }, { 'orders.view': 'own' }), false,
    )).toThrow(expect.objectContaining({ details: expect.objectContaining({ blocked: [expect.objectContaining({ scope: 'orders.view' })] }) }));
    // Granting and widening stay allowed.
    expect(() => assertNoUnclosedHasuraNarrowing(
      scoped({ 'clients.view': false }, { 'orders.view': 'own' }),
      scoped({ 'clients.view': true }, { 'orders.view': 'all' }), false,
    )).not.toThrow();
    // From `none` every value is a widening; own ↔ assigned loses records and stays refused.
    for (const value of ['own', 'assigned']) {
      expect(() => assertNoUnclosedHasuraNarrowing(
        scoped({}, { 'orders.view': 'none' }), scoped({}, { 'orders.view': value }), false,
      )).not.toThrow();
    }
    expect(() => assertNoUnclosedHasuraNarrowing(
      scoped({}, { 'orders.view': 'own' }), scoped({}, { 'orders.view': 'assigned' }), false,
    )).toThrow(expect.objectContaining({ code: 'PERMISSION_NARROWING_BLOCKED' }));
    // Once Hasura follows the permissions the same narrowing is allowed.
    expect(() => assertNoUnclosedHasuraNarrowing(
      scoped({ 'clients.view': true }, { 'orders.view': 'all' }),
      scoped({ 'clients.view': false }, { 'orders.view': 'own' }), true,
    )).not.toThrow();
  });

  it('lets orders.view_financials go only once step F2 closed the money columns (financials state `closed`)', () => {
    const before = matrix({ '2': { 'orders.view_financials': true, 'orders.view': true } });
    const next = matrix({ '2': { 'orders.view_financials': false, 'orders.view': true } });
    for (const state of ['open', 'reverting'] as const) {
      expect(() => assertNoUnclosedHasuraNarrowing(before, next, true, state)).toThrow(
        expect.objectContaining({ code: 'PERMISSION_NARROWING_BLOCKED', details: expect.objectContaining({ hasuraFinancialsState: state }) }),
      );
    }
    expect(() => assertNoUnclosedHasuraNarrowing(before, next, true, 'closed')).not.toThrow();
    // Closed money columns do not lift the 0Б rule: before step B (or after its revert) nothing may be narrowed.
    expect(() => assertNoUnclosedHasuraNarrowing(before, next, false, 'closed')).toThrow(
      expect.objectContaining({ code: 'PERMISSION_NARROWING_BLOCKED' }),
    );
    expect(HASURA_UNCLOSED_PERMISSIONS['orders.view_financials']?.closedBy).toBe('closed');
  });

  it('the release snapshot (after F2) serves money of orders, details and doweling orders only with orders.view_financials', () => {
    const metadata = JSON.parse(readFileSync(resolve(__dirname, '../../../ops/hasura/metadata.json'), 'utf8'));
    const root = metadata.metadata ?? metadata;
    const financial = ['final_amount', 'paid_amount', 'total_amount', 'discount', 'surcharge', 'detail_cost', 'milling_cost_per_sqm',
      'payment_status_name', 'payment_status_id', 'payment_date', 'purchase_price'];
    const sources = ['orders_view', 'order_details', 'order_details_view', 'doweling_orders', 'doweling_orders_view',
      'order_financials_view', 'order_detail_financials_view', 'doweling_order_financials_view', 'order_resource_requirements'];
    const exposing: string[] = [];
    for (const source of root.sources) {
      for (const table of source.tables) {
        if (!sources.includes(table.table.name)) continue;
        for (const permission of table.select_permissions ?? []) {
          const columns = permission.permission.columns;
          const readsFinancial = columns === '*' || financial.some((column) => columns.includes(column));
          const requiresFinancials = JSON.stringify(permission.permission.filter ?? {}).includes('"orders.view_financials"');
          if (readsFinancial && !requiresFinancials) exposing.push(`${table.table.name}/${permission.role}`);
        }
      }
    }
    expect(exposing).toEqual([]);
  });
});
