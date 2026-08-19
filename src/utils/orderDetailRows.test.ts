import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../types/orders';
import {
  appendOrderDetailEmptyTailRowsForDisplay,
  businessOrderDetails,
  clearOrderDetailTailRowValues,
  collectOrderDetailEmptyTailRowsForDisplay,
  collectNewEmptyTailDetailKeys,
  countOrderDetailsWithRequiredEntryValues,
  hasOrderDetailRequiredEntryValues,
  prepareOrderDetailsForSave,
  promoteOrderDetailOptions,
  recentOrderDetailReferenceIds,
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

  it('collects display-only empty tail rows separately from save rows', () => {
    const rows = [
      validDetail({ temp_id: 1, detail_number: 1 }),
      validDetail({
        temp_id: 2,
        detail_number: 2,
        height: 0,
        width: 0,
        quantity: 1,
        milling_cost_per_sqm: null,
        detail_cost: null,
        note: 'tail draft',
      }),
    ];

    expect(collectOrderDetailEmptyTailRowsForDisplay(rows)).toEqual([
      expect.objectContaining({
        temp_id: 2,
        detail_number: 2,
        height: null,
        width: null,
        quantity: null,
        detail_cost: null,
        note: null,
      }),
    ]);
  });

  it('appends display-only tail rows after backend rows without persisting ids', () => {
    const restored = appendOrderDetailEmptyTailRowsForDisplay(
      [
        validDetail({ detail_id: 10, temp_id: 10, detail_number: 1 }),
        validDetail({ detail_id: 11, temp_id: 11, detail_number: 2 }),
      ],
      [
        validDetail({
          temp_id: 44,
          detail_number: 99,
          height: null as unknown as number,
          width: null as unknown as number,
          quantity: null as unknown as number,
          milling_cost_per_sqm: null,
          detail_cost: null,
        }),
      ],
      77,
    );

    expect(restored.map((row) => row.detail_number)).toEqual([1, 2, 3]);
    expect(restored[2]).toMatchObject({
      detail_id: undefined,
      order_id: 77,
      delete_flag: false,
      height: null,
      width: null,
      quantity: null,
      detail_cost: null,
    });
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

const uiDetail = (overrides: Partial<OrderDetail> = {}): OrderDetail => ({
  ...validDetail(),
  ...overrides,
});

describe('order detail UI rows', () => {
  it('excludes placeholders from business rows', () => {
    const rows = [uiDetail({ temp_id: 1 }), uiDetail({ temp_id: 2, is_placeholder: true })];
    expect(businessOrderDetails(rows).map((row) => row.temp_id)).toEqual([1]);
  });

  it('collects unique prior order values newest-first and skips placeholders', () => {
    const rows = [
      uiDetail({ temp_id: 1, detail_number: 1, film_id: 10 }),
      uiDetail({ temp_id: 2, detail_number: 2, film_id: 20 }),
      uiDetail({ temp_id: 3, detail_number: 3, film_id: 10 }),
      uiDetail({ temp_id: 4, detail_number: 4, film_id: 30, is_placeholder: true }),
      uiDetail({ temp_id: 5, detail_number: 5, film_id: null }),
    ];

    expect(recentOrderDetailReferenceIds(rows, rows[4], 'film_id')).toEqual([10, 20]);
  });

  it('keeps catalog order after available recent values', () => {
    const catalog = [
      { value: 1, label: 'A', metadata: 'a' },
      { value: 2, label: 'B', metadata: 'b' },
      { value: 3, label: 'C', metadata: 'c' },
    ];

    expect(promoteOrderDetailOptions(catalog, [2, 1, 999]).map((option) => option.value))
      .toEqual([2, 1, 3]);
    expect(promoteOrderDetailOptions(catalog, [])).toEqual(catalog);
  });

  it('caps prior values at twenty', () => {
    const rows = Array.from({ length: 25 }, (_, index) => uiDetail({
      temp_id: index + 1,
      detail_number: index + 1,
      production_status_id: index + 1,
    }));
    const current = uiDetail({ temp_id: 100, detail_number: 26 });
    rows.push(current);

    const ids = recentOrderDetailReferenceIds(rows, current, 'production_status_id');
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 2)).toEqual([25, 24]);
  });
});
