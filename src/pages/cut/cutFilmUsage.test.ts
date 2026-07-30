import { describe, expect, it } from 'vitest';
import type { CutJobDto, SheetPlacements } from '../../api/types/cutApi.types';
import type { OrderDetail } from '../../types/orders';
import {
  computeOrderBathFilmUsage,
  formatFilmLinearMeters,
  totalFilmUsageMeters,
} from './cutFilmUsage';

const bathSheet = (yMm: number, detailId = 10): SheetPlacements => ({
  sheet_width_mm: 1050,
  sheet_height_mm: 2800,
  trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
  pieces: [{
    item_id: `det-${detailId}`,
    instance: 1,
    x_mm: 0,
    y_mm: yMm,
    width_mm: 100,
    height_mm: 100,
    rotated: false,
  }],
});

const orderDetail = (detailId = 10, filmId = 5): OrderDetail => ({
  detail_id: detailId,
  detail_number: 1,
  height: 100,
  width: 100,
  quantity: 1,
  area: 0.01,
  material_id: null,
  sheet_material_type_id: 7,
  material_name_resolved: 'Ванна 2080x1050',
  milling_type_id: 1,
  edge_type_id: 1,
  film_id: filmId,
  priority: 100,
});

const cutJob = (placements: SheetPlacements, overrides: Partial<CutJobDto> = {}): CutJobDto => ({
  cutJobId: 22,
  name: 'Раскрой',
  status: 'ready',
  source: 'manual',
  version: 1,
  pdfPrewarmState: 'idle',
  paramProfileId: 1,
  sheetMaterialTypeId: null,
  pdfTemplate: 'standard',
  combineFilms: false,
  splitByMaterial: true,
  materialNames: ['Ванна 2080x1050'],
  totals: { positions: 1, details: 1, area: 0.01, sheets: 1, materialsCount: 1, filmsCount: 1, filmUsage: [] },
  items: [{
    cutJobItemId: 1,
    orderDetailId: 10,
    orderId: 100,
    qty: 1,
    cutGroupId: 77,
    detail: {
      detailNumber: 1,
      detailName: null,
      height: 100,
      width: 100,
      quantity: 1,
      area: 0.01,
      materialId: null,
      sheetMaterialTypeId: 7,
      materialName: 'Ванна 2080x1050',
      millingTypeId: 1,
      millingTypeName: null,
      edgeTypeId: 1,
      edgeTypeName: null,
      filmId: 5,
      filmName: 'Айвори',
      filmTexture: false,
      priority: 100,
      productionStatusId: null,
      productionStatusName: null,
      jointOrderId: null,
      note: null,
      linkCuttingFile: null,
      linkCuttingImageFile: null,
      linkCadFile: null,
      linkPdfFile: null,
    },
  }],
  groups: [{
    cutGroupId: 77,
    sheetMaterialTypeId: 7,
    sheetMaterialName: 'Ванна 2080x1050',
    sheetMaterialWidthMm: 1050,
    sheetMaterialHeightMm: 2800,
    filmId: 5,
    status: 'ready',
    pdfTemplate: 'standard',
    summary: { engine_used: 'vacuum_table' },
    sheets: [{ cutGroupSheetId: 1, sheetIndex: 0, pngCacheKey: null, placements }],
  }],
  ...overrides,
});

describe('cut film usage helpers', () => {
  it('formats and sums linear meters', () => {
    expect(formatFilmLinearMeters(3.1)).toBe('3,1 пог. м');
    expect(totalFilmUsageMeters([{ linearMeters: 1.1 }, { linearMeters: 2.1 }])).toBe(3.2);
  });

  it('computes order bath film usage from sheets containing order details', () => {
    expect(computeOrderBathFilmUsage(
      [orderDetail()],
      [cutJob(bathSheet(900))],
      new Map([[5, 'Айвори']]),
    )).toEqual([{
      filmId: 5,
      filmName: 'Айвори',
      linearMeters: 2.1,
      sheets: 1,
      cutJobIds: [22],
    }]);
  });

  it('uses active fresh manual sheets over automatic sheets', () => {
    const job = cutJob(bathSheet(100));
    job.groups[0].manualLayout = {
      groupKey: 'm:7|f:5',
      isActive: true,
      isStale: false,
      version: 2,
      sheets: [{ sheetIndex: 0, placements: bathSheet(1900) }],
    };
    expect(computeOrderBathFilmUsage([orderDetail()], [job])[0].linearMeters).toBe(3.1);
  });

  it('uses the cut group sheet material when order detail material is MDF', () => {
    const detail = { ...orderDetail(), material_name_resolved: 'МДФ 16мм' };
    const job = cutJob(bathSheet(900));
    if (job.items[0].detail) job.items[0].detail.materialName = 'МДФ 16мм';

    expect(computeOrderBathFilmUsage([detail], [job])[0].linearMeters).toBe(2.1);
  });

  it('ignores non-vacuum jobs and sheets without this order details', () => {
    const job = cutJob(bathSheet(100, 999));
    job.groups[0].summary = { engine_used: 'guillotine' };
    expect(computeOrderBathFilmUsage([orderDetail()], [job])).toEqual([]);
  });
});
