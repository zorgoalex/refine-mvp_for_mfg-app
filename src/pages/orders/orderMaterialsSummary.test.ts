import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../../types/orders';
import {
  buildOrderFilmMaterialRows,
  buildOrderHeaderMaterialSummaryItems,
  buildOrderSheetMaterialRows,
  buildUsableHdfAreaM2,
} from './orderMaterialsSummary';

const detail = (overrides: Partial<OrderDetail> = {}): OrderDetail => ({
  detail_id: 1,
  detail_number: 1,
  height: 1000,
  width: 500,
  quantity: 2,
  area: 1,
  material_id: null,
  sheet_material_type_id: 8,
  material_name_resolved: 'МДФ 16мм',
  milling_type_id: 1,
  edge_type_id: 1,
  film_id: 5,
  priority: 100,
  ...overrides,
});

describe('order material summary helpers', () => {
  it('combines film area with bath linear meters and cut job ids', () => {
    const rows = buildOrderFilmMaterialRows(
      [
        detail({ detail_id: 1, film_id: 5 }),
        detail({ detail_id: 2, film_id: 5, height: 400, width: 500, quantity: 1 }),
      ],
      [{ filmId: 5, filmName: 'Айвори', linearMeters: 2.1, sheets: 1, cutJobIds: [22] }],
      new Map([[5, 'Айвори']]),
    );

    expect(rows).toEqual([{
      key: 'film:5',
      filmId: 5,
      name: 'Айвори',
      totalArea: 1.2,
      detailsCount: 2,
      bathLinearMeters: 2.1,
      bathSheets: 1,
      cutJobIds: [22],
    }]);
  });

  it('aggregates sheet material area from order details', () => {
    const rows = buildOrderSheetMaterialRows(
      [
        detail({ detail_id: 1, sheet_material_type_id: 8, material_name_resolved: 'МДФ 16мм' }),
        detail({ detail_id: 2, sheet_material_type_id: 8, material_name_resolved: 'МДФ 16мм', height: 400, width: 500, quantity: 1 }),
      ],
      (row) => row.material_name_resolved,
    );

    expect(rows).toEqual([{
      key: 'sheet:8',
      sheetMaterialTypeId: 8,
      name: 'МДФ 16мм',
      totalArea: 1.2,
      detailsCount: 2,
    }]);
  });

  it('adds only fresh usable HDF rows to sheet material summary', () => {
    const rows = buildOrderSheetMaterialRows(
      [detail({ detail_id: 1, sheet_material_type_id: 8, material_name_resolved: 'МДФ 16мм' })],
      (row) => row.material_name_resolved,
      [
        {
          order_hdf_detail_id: 11,
          source_order_detail_id_snapshot: 1,
          hdf_sheet_material_type_id: 9,
          hdf_sheet_material_name: 'ХДФ 3мм',
          quantity: 2,
          area_m2: 0.45,
          status: 'ok',
          is_stale: false,
          version: 1,
        },
        {
          order_hdf_detail_id: 12,
          source_order_detail_id_snapshot: 2,
          hdf_sheet_material_type_id: 9,
          hdf_sheet_material_name: 'ХДФ 3мм',
          quantity: 10,
          area_m2: 9,
          status: 'too_narrow',
          is_stale: false,
          version: 1,
        },
      ],
    );

    expect(rows).toEqual([
      {
        key: 'sheet:8',
        sheetMaterialTypeId: 8,
        name: 'МДФ 16мм',
        totalArea: 1,
        detailsCount: 1,
      },
      {
        key: 'sheet:9',
        sheetMaterialTypeId: 9,
        name: 'ХДФ 3мм',
        totalArea: 0.45,
        detailsCount: 2,
      },
    ]);
  });

  it('returns zero usable HDF area when order has no fresh HDF', () => {
    expect(buildUsableHdfAreaM2([
      {
        order_hdf_detail_id: 11,
        source_order_detail_id_snapshot: 1,
        area_m2: 0.45,
        status: 'ok',
        is_stale: true,
        version: 1,
      },
    ])).toBe(0);
  });

  it('adds calculated HDF materials to the order header material line', () => {
    expect(buildOrderHeaderMaterialSummaryItems(['МДФ 16мм'], [
      {
        order_hdf_detail_id: 11,
        source_order_detail_id_snapshot: 1,
        hdf_sheet_material_type_id: 9,
        hdf_sheet_material_name: 'ХДФ 3мм',
        quantity: 2,
        area_m2: 0.45,
        status: 'ok',
        is_stale: false,
        version: 1,
      },
      {
        order_hdf_detail_id: 12,
        source_order_detail_id_snapshot: 2,
        hdf_sheet_material_type_id: 9,
        hdf_sheet_material_name: 'ХДФ 3мм',
        quantity: 10,
        area_m2: 9,
        status: 'too_narrow',
        is_stale: false,
        version: 1,
      },
      {
        order_hdf_detail_id: 13,
        source_order_detail_id_snapshot: 3,
        hdf_sheet_material_type_id: 9,
        hdf_sheet_material_name: 'ХДФ 3мм',
        quantity: 1,
        area_m2: 0.1,
        status: 'ok',
        is_stale: true,
        version: 1,
      },
    ])).toEqual([
      {
        key: 'detail:МДФ 16мм',
        label: 'МДФ 16мм',
        colorName: 'МДФ 16мм',
        source: 'detail',
      },
      {
        key: 'hdf-sheet:9',
        label: 'ХДФ 3мм: 0,45 м²',
        colorName: 'ХДФ 3мм',
        source: 'hdf',
      },
    ]);
  });
});
