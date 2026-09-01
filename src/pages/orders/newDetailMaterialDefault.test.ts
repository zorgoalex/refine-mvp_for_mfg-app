import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../../types/orders';
import {
  insertedDetailMaterialDefault,
  newDetailMaterialDefault,
} from './newDetailMaterialDefault';

const detail = (values: Partial<OrderDetail>): OrderDetail => ({
  detail_number: 1,
  milling_type_id: 1,
  edge_type_id: 1,
  priority: 100,
  ...values,
} as OrderDetail);

describe('newDetailMaterialDefault', () => {
  it('uses catalog minimum for the first detail of a new order', () => {
    expect(newDetailMaterialDefault([], 7)).toBe(7);
  });

  it('inherits material from the preceding new detail', () => {
    expect(newDetailMaterialDefault([
      detail({ detail_number: 1, sheet_material_type_id: 12 }),
      detail({ detail_number: 2, sheet_material_type_id: 25 }),
    ], 7, 3)).toBe(25);
  });

  it('ignores persisted rows for the first new detail of an existing order', () => {
    expect(newDetailMaterialDefault([
      detail({ detail_id: 91, detail_number: 1, sheet_material_type_id: 25 }),
      detail({ detail_id: 92, detail_number: 2, sheet_material_type_id: 12 }),
    ], 7)).toBe(7);
  });

  it('uses the first unsaved row for later additions to an existing order', () => {
    expect(newDetailMaterialDefault([
      detail({ detail_id: 91, detail_number: 1, sheet_material_type_id: 25 }),
      detail({ detail_number: 2, sheet_material_type_id: 12 }),
    ], 7)).toBe(12);
  });
});

describe('insertedDetailMaterialDefault', () => {
  it('inherits only from an unsaved previous row', () => {
    expect(insertedDetailMaterialDefault(detail({ sheet_material_type_id: 12 }), 7)).toBe(12);
    expect(insertedDetailMaterialDefault(
      detail({ detail_id: 91, sheet_material_type_id: 12 }),
      7,
    )).toBe(7);
  });
});
