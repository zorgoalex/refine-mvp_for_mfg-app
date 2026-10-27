import { describe, expect, it } from 'vitest';
import { buildOrderSheetMaterialRows } from './orderMaterialsSummary';
import { resolveOrderShowHdfDetails } from './orderShowHdfDetails';

const mapped = {
  order_hdf_detail_id: 7,
  order_id: 15,
  source_order_detail_id: 101,
  hdf_sheet_material_type_id: 15,
  hdf_sheet_material_name: 'ХДФ 3мм',
  quantity: 2,
  area_m2: 0.49,
  status: 'ok',
  is_stale: false,
};

describe('resolveOrderShowHdfDetails', () => {
  it('keeps the already mapped ХДФ parts of the backend read, so ХДФ reaches the sheet materials', () => {
    const hdfDetails = resolveOrderShowHdfDetails({ header: { order_id: 15 }, hdfDetails: [mapped] });

    expect(hdfDetails).toEqual([mapped]);
    expect(buildOrderSheetMaterialRows([], () => null, hdfDetails)).toEqual([
      { key: 'sheet:15', sheetMaterialTypeId: 15, name: 'ХДФ 3мм', totalArea: 0.49, detailsCount: 2 },
    ]);
  });

  it('still maps a raw order DTO', () => {
    const hdfDetails = resolveOrderShowHdfDetails({
      header: { orderId: 15 },
      hdfDetails: [{
        id: 7, sourceOrderDetailId: 101, hdfSheetMaterialTypeId: 15, hdfSheetMaterialName: 'ХДФ 3мм',
        quantity: 2, areaM2: 0.49, status: 'ok', isStale: false,
      }],
    });

    expect(hdfDetails).toHaveLength(1);
    expect(hdfDetails[0]).toMatchObject({ order_hdf_detail_id: 7, area_m2: 0.49, status: 'ok', hdf_sheet_material_type_id: 15 });
  });

  it('returns nothing without a backend order or ХДФ parts', () => {
    expect(resolveOrderShowHdfDetails(null)).toEqual([]);
    expect(resolveOrderShowHdfDetails({ header: {}, hdfDetails: [] })).toEqual([]);
  });
});
