import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./070_reference_catalog_sort_order.sql', import.meta.url),
  'utf8',
);

const addedCatalogs = [
  'clients',
  'materials',
  'sheet_material_types',
  'films',
  'film_types',
  'vendors',
  'suppliers',
  'units',
  'transaction_direction',
  'workshops',
  'work_centers',
];

const allCatalogs = [
  ...addedCatalogs,
  'milling_types',
  'edge_types',
  'material_types',
  'order_statuses',
  'payment_statuses',
  'payment_types',
  'requisition_statuses',
  'movements_statuses',
  'material_transaction_types',
  'production_statuses',
  'resource_requirements_statuses',
];

describe('070 reference catalog sort order migration', () => {
  it.each(addedCatalogs)('adds a defaulted non-null sort_order to %s', (table) => {
    expect(sql).toMatch(
      new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sort_order SMALLINT NOT NULL DEFAULT 100`, 'i'),
    );
  });

  it.each(allCatalogs)('sets the default for %s', (table) => {
    expect(sql).toMatch(
      new RegExp(`ALTER TABLE ${table} ALTER COLUMN sort_order SET DEFAULT 100`, 'i'),
    );
  });

  it('removes only the legacy sort-order uniqueness constraints', () => {
    for (const constraint of [
      'uq_order_statuses_sort_order',
      'uq_payment_statuses_sort_order',
      'uq_production_statuses_sort_order',
    ]) {
      expect(sql).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`, 'i'));
    }
    expect(sql).not.toMatch(/ADD\s+(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s*\(\s*sort_order\s*\)/i);
    expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*sort_order/i);
  });
});
