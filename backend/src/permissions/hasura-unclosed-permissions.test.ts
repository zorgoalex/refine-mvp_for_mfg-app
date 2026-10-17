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

describe('PERMISSION_NARROWING_BLOCKED (access groups 0Б)', () => {
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

  it('keeps orders.view_financials blocked while a Hasura select exposes financial columns without requiring it', () => {
    // Guard against removing the entry before the «finances» stage closes the columns (metadata snapshot = stage).
    const metadata = JSON.parse(readFileSync(resolve(__dirname, '../../../ops/hasura/metadata.json'), 'utf8'));
    const root = metadata.metadata ?? metadata;
    const financial = ['final_amount', 'paid_amount', 'total_amount', 'discount', 'surcharge', 'detail_cost'];
    const exposing: string[] = [];
    for (const source of root.sources) {
      for (const table of source.tables) {
        for (const permission of table.select_permissions ?? []) {
          const columns = permission.permission.columns;
          const readsFinancial = columns === '*' ? true : financial.some((column) => columns.includes(column));
          const requiresFinancials = JSON.stringify(permission.permission.filter ?? {}).includes('"orders.view_financials"');
          if (readsFinancial && !requiresFinancials && ['orders_view', 'order_details', 'order_details_view', 'doweling_orders', 'doweling_orders_view'].includes(table.table.name)) {
            exposing.push(`${table.table.name}/${permission.role}`);
          }
        }
      }
    }
    expect(exposing.length).toBeGreaterThan(0);
    expect(Object.keys(HASURA_UNCLOSED_PERMISSIONS)).toContain('orders.view_financials');
  });
});
