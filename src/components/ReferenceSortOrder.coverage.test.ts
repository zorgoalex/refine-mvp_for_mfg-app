import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const referencePages: Array<[directory: string, idField: string]> = [
  ['clients', 'client_id'],
  ['materials', 'material_id'],
  ['sheet-materials', 'sheet_material_type_id'],
  ['milling_types', 'milling_type_id'],
  ['films', 'film_id'],
  ['edge_types', 'edge_type_id'],
  ['vendors', 'vendor_id'],
  ['suppliers', 'supplier_id'],
  ['film_types', 'film_type_id'],
  ['material_types', 'material_type_id'],
  ['units', 'unit_id'],
  ['order_statuses', 'order_status_id'],
  ['payment_statuses', 'payment_status_id'],
  ['payment_types', 'type_paid_id'],
  ['requisition_statuses', 'requisition_status_id'],
  ['movements_statuses', 'movement_status_id'],
  ['material_transaction_types', 'transaction_type_id'],
  ['transaction_direction', 'direction_type_id'],
  ['production_statuses', 'production_status_id'],
  ['resource_requirements_statuses', 'requirement_status_id'],
  ['workshops', 'workshop_id'],
  ['work_centers', 'workcenter_id'],
];

const pageSource = (directory: string, page: string): string => readFileSync(
  resolve(process.cwd(), 'src/pages', directory, `${page}.tsx`),
  'utf8',
);

describe('reference sort-order UI coverage', () => {
  it.each(referencePages)('%s exposes sort order in create and edit forms', (directory) => {
    for (const page of ['create', 'edit']) {
      expect(pageSource(directory, page)).toMatch(
        /sort_order|sortOrder|ReferenceSortOrderFormItem/,
      );
    }
  });

  it.each(referencePages)('%s list uses sort order with a stable id tie-breaker', (directory, idField) => {
    const source = pageSource(directory, 'list');
    expect(source).toMatch(/sort_order|sortOrder|ReferenceSortOrderColumn/);
    expect(source).toContain(idField);
  });

  it.each(referencePages)('%s show page includes sort order when present', (directory) => {
    const showPath = resolve(process.cwd(), 'src/pages', directory, 'show.tsx');
    if (!existsSync(showPath)) return;
    expect(readFileSync(showPath, 'utf8')).toMatch(
      /sort_order|sortOrder|ReferenceSortOrderShow/,
    );
  });
});
