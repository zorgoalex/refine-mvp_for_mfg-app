import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Task 8 (SP3): the new sheet_material_type_id / order_details_view reads must be
// wired into RESOURCE_FIELDS + ID_COLUMNS so Hasura-mode reads return them.
const src = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

// Extract the array body of a RESOURCE_FIELDS entry like `name: [ ... ],`.
function fieldsBlock(resource: string): string {
  const start = src.indexOf(`${resource}: [`);
  expect(start, `RESOURCE_FIELDS.${resource} present`).toBeGreaterThan(-1);
  const end = src.indexOf('],', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('dataProvider SP3 sheet field wiring', () => {
  it('order_details reads sheet_material_type_id', () => {
    expect(fieldsBlock('order_details')).toContain('"sheet_material_type_id"');
  });

  it('orders reads sheet_material_type_id + sheet_eligible', () => {
    const block = fieldsBlock('orders');
    expect(block).toContain('"sheet_material_type_id"');
    expect(block).toContain('"sheet_eligible"');
  });

  it('orders_view reads sheet_material_type_id', () => {
    expect(fieldsBlock('orders_view')).toContain('"sheet_material_type_id"');
  });

  it('order_details_view is registered with server-resolved material_name', () => {
    expect(src).toMatch(/order_details_view:\s*"detail_id"/); // ID_COLUMNS
    const block = fieldsBlock('order_details_view');
    expect(block).toContain('"material_name"');
    expect(block).toContain('"sheet_material_type_id"');
  });
});
