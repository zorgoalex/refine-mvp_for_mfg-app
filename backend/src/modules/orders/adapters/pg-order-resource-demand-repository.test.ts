import { describe, expect, it } from 'vitest';
import { buildOrderResourceDemandProjection } from './pg-order-resource-demand-repository';

describe('buildOrderResourceDemandProjection', () => {
  it('groups current detail areas and uses the active manual bath layout for film meters', () => {
    const result = buildOrderResourceDemandProjection({
      orders: [{
        order_id: 101,
        order_name: '55',
        full_number: 'МП-55',
        order_date: '2026-07-31',
        project_code: 'МП',
        client_name: 'Клиент',
        updated_at: '2026-07-31T10:00:00.000Z',
      }],
      details: [
        detail({ detail_id: 1, height: 1000, width: 500, quantity: 2 }),
        detail({ detail_id: 2, height: 500, width: 500, quantity: 1 }),
      ],
      detailCutJobs: [
        { order_detail_id: 1, cut_job_id: 900 },
        { order_detail_id: 2, cut_job_id: 900 },
      ],
      cutGroups: [{
        cut_job_id: 900,
        cut_group_id: 901,
        summary: { engine_used: 'vacuum_table' },
        sheet_material_name: 'Ванна 1400',
        sheet_material_width_mm: 1400,
        sheet_material_height_mm: 2800,
        manual_is_active: true,
        manual_is_stale: false,
        manual_sheets: [{
          sheetIndex: 0,
          placements: placements(0),
        }],
      }],
      cutSheets: [{
        cut_group_id: 901,
        sheet_index: 0,
        placements: placements(1900),
      }],
    });

    expect(result).toEqual([{
      orderId: 101,
      orderName: '55',
      fullNumber: 'МП-55',
      orderDate: '2026-07-31',
      projectCode: 'МП',
      clientName: 'Клиент',
      updatedAt: '2026-07-31T10:00:00.000Z',
      sheetMaterials: [{
        sheetMaterialTypeId: 11,
        name: 'Ванна 1400',
        totalArea: 1.25,
        detailsCount: 2,
        supplierId: 31,
        supplierName: 'Листы ООО',
      }],
      films: [{
        filmId: 21,
        name: 'Белая плёнка',
        totalArea: 1.25,
        detailsCount: 2,
        linearMeters: 1.1,
        sheets: 1,
        hasCutData: true,
        vendorId: 41,
        vendorName: 'Плёнка ООО',
      }],
    }]);
  });

  it('does not report meters from a stale or non-latest cut mapping', () => {
    const result = buildOrderResourceDemandProjection({
      orders: [{
        order_id: 101,
        order_name: '55',
        full_number: 'МП-55',
        order_date: null,
        project_code: 'МП',
        client_name: null,
        updated_at: '2026-07-31T10:00:00.000Z',
      }],
      details: [detail({ detail_id: 1 })],
      detailCutJobs: [{ order_detail_id: 1, cut_job_id: 999 }],
      cutGroups: [{
        cut_job_id: 900,
        cut_group_id: 901,
        summary: { engine_used: 'vacuum_table' },
        sheet_material_name: 'Ванна 1400',
        sheet_material_width_mm: 1400,
        sheet_material_height_mm: 2800,
        manual_is_active: null,
        manual_is_stale: null,
        manual_sheets: null,
      }],
      cutSheets: [{ cut_group_id: 901, sheet_index: 0, placements: placements(0) }],
    });

    expect(result[0]?.films[0]).toMatchObject({
      linearMeters: 0,
      sheets: 0,
      hasCutData: false,
    });
  });
});

function detail(overrides: Record<string, unknown>) {
  return {
    detail_id: 1,
    order_id: 101,
    height: 1000,
    width: 500,
    quantity: 1,
    sheet_material_type_id: 11,
    sheet_material_name: 'Ванна 1400',
    supplier_id: 31,
    supplier_name: 'Листы ООО',
    film_id: 21,
    film_name: 'Белая плёнка',
    vendor_id: 41,
    vendor_name: 'Плёнка ООО',
    ...overrides,
  };
}

function placements(yMm: number) {
  return {
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    sheet_width_mm: 1400,
    sheet_height_mm: 2800,
    pieces: [{
      item_id: 'det-1',
      instance: 1,
      x_mm: 0,
      y_mm: yMm,
      width_mm: 500,
      height_mm: 500,
      rotated: false,
    }],
  };
}
