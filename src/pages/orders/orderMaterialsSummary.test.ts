import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../../types/orders';
import { buildOrderFilmMaterialRows, buildOrderSheetMaterialRows } from './orderMaterialsSummary';

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
});
