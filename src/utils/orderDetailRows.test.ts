import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../types/orders';
import {
  clearOrderDetailTailRowValues,
  collectNewEmptyTailDetailKeys,
  countOrderDetailsWithRequiredEntryValues,
  hasOrderDetailRequiredEntryValues,
  prepareOrderDetailsForSave,
} from './orderDetailRows';

const validDetail = (overrides: Partial<OrderDetail> = {}): OrderDetail => ({
  temp_id: 1,
  detail_number: 1,
  height: 100,
  width: 200,
  quantity: 2,
  area: 0.04,
  material_id: null,
  sheet_material_type_id: 7,
  milling_type_id: 1,
  edge_type_id: 1,
  milling_cost_per_sqm: 100,
  detail_cost: 400,
  priority: 100,
  ...overrides,
});

describe('order detail tail row preparation', () => {
  it('drops and clears only new empty rows at the bottom of the detail list', () => {
    const rows = [
      validDetail({ temp_id: 1, detail_number: 1 }),
      validDetail({
        temp_id: 2,
        detail_number: 2,
        height: null as unknown as number,
        width: null as unknown as number,
        quantity: null as unknown as number,
        area: null as unknown as number,
        sheet_material_type_id: 7,
        milling_type_id: 1,
        edge_type_id: 1,
        milling_cost_per_sqm: null,
        detail_cost: null,
        note: 'will be cleared',
      }),
      validDetail({
        temp_id: 3,
        detail_number: 3,
        height: 0,
        width: null as unknown as number,
        quantity: 1,
        area: null as unknown as number,
        milling_cost_per_sqm: null,
        detail_cost: null,
        basis_project: 'will be cleared too',
      }),
    ];

    const prepared = prepareOrderDetailsForSave(rows);

    expect(prepared.emptyTailCount).toBe(2);
    expect(prepared.detailsForSave.map((row) => row.temp_id)).toEqual([1]);
    expect(prepared.detailsForDisplay[1]).toMatchObject({
      temp_id: 2,
      detail_number: 2,
      height: null,
      width: null,
      quantity: null,
      detail_cost: null,
      note: null,
      sheet_material_type_id: null,
      milling_type_id: null,
      edge_type_id: null,
    });
    expect(prepared.detailsForDisplay[2]).toMatchObject({
      temp_id: 3,
      detail_number: 3,
      basis_project: null,
      detail_cost: null,
    });
  });

  it('keeps partially filled tail rows for normal validation', () => {
    const rows = [
      validDetail({ temp_id: 1, detail_number: 1 }),
      validDetail({
        temp_id: 2,
        detail_number: 2,
        height: 300,
        width: null as unknown as number,
        quantity: null as unknown as number,
        area: null as unknown as number,
        milling_cost_per_sqm: null,
        detail_cost: null,
      }),
    ];

    const prepared = prepareOrderDetailsForSave(rows);

    expect(prepared.emptyTailCount).toBe(0);
    expect(prepared.detailsForSave.map((row) => row.temp_id)).toEqual([1, 2]);
  });

  it('keeps incomplete rows that are not in the bottom tail for normal validation', () => {
    const rows = [
      validDetail({
        temp_id: 1,
        detail_number: 1,
        detail_cost: null,
      }),
      validDetail({ temp_id: 2, detail_number: 2 }),
    ];

    const prepared = prepareOrderDetailsForSave(rows);

    expect(prepared.emptyTailCount).toBe(0);
    expect(prepared.detailsForSave.map((row) => row.temp_id)).toEqual([1, 2]);
  });

  it('never drops existing persisted rows automatically', () => {
    const rows = [
      validDetail({ detail_id: 10, temp_id: 10, detail_number: 1, height: null as unknown as number }),
    ];

    const prepared = prepareOrderDetailsForSave(rows);

    expect(prepared.emptyTailCount).toBe(0);
    expect(prepared.detailsForSave).toHaveLength(1);
  });

  it('counts rows with required entry values for scroll height and save gate', () => {
    expect(hasOrderDetailRequiredEntryValues(validDetail())).toBe(true);
    expect(hasOrderDetailRequiredEntryValues(validDetail({ detail_cost: null }))).toBe(false);
    expect(countOrderDetailsWithRequiredEntryValues([
      validDetail(),
      validDetail({ height: null as unknown as number }),
    ])).toBe(1);
  });

  it('clears user-entered values while preserving row identity', () => {
    const cleared = clearOrderDetailTailRowValues(validDetail({
      temp_id: 44,
      detail_number: 7,
      note: 'text',
      basis_designation: 'A-1',
    }));

    expect(cleared.temp_id).toBe(44);
    expect(cleared.detail_number).toBe(7);
    expect(cleared.note).toBeNull();
    expect(cleared.basis_designation).toBeNull();
    expect(cleared.height).toBeNull();
  });

  it('uses detail_number order when collecting empty tail rows', () => {
    const rows = [
      validDetail({
        temp_id: 3,
        detail_number: 3,
        height: 0,
        width: 0,
        quantity: 1,
        milling_cost_per_sqm: null,
        detail_cost: null,
      }),
      validDetail({ temp_id: 1, detail_number: 1 }),
      validDetail({ temp_id: 2, detail_number: 2 }),
    ];

    expect([...collectNewEmptyTailDetailKeys(rows)]).toEqual(['temp:3']);
  });
});
