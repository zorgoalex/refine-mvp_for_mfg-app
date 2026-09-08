import { describe, expect, it } from 'vitest';
import type { CutJobDto, SheetPlacements } from '../../api/types/cutApi.types';
import { cutJobInformationalDetails } from './cutJobInformationalDetails';

const piece = (itemId: string, orderName: string, orderId: number | null, detailId: number | null) => ({
  item_id: itemId, instance: 1, x_mm: 10, y_mm: 10, width_mm: 575, height_mm: 875, rotated: true,
  label: { orderName, orderId, detailId, detailNumber: 3, widthMm: 875, heightMm: 575, materialName: 'МДФ 16мм' },
});
const placements: SheetPlacements = {
  sheet_width_mm: 2000, sheet_height_mm: 2800, trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
  pieces: [piece('det-42', '2895', 11619, 42), piece('svg-11', '2900', null, null), piece('svg-12', '2900', null, null)],
  renderOnlyContours: [{ sourceElementId: '_2885_PartContour', xMm: 900, yMm: 500,
    placedWidthMm: 492, placedHeightMm: 500, labelLines: ['2885', '# Test', '500*492'] }],
};
function jobWith(layout: SheetPlacements): CutJobDto {
  return {
    items: [{ orderDetailId: 42 }],
    groups: [{ cutGroupId: 536, sheets: [{ cutGroupSheetId: 1244, sheetIndex: 0, placements: layout }] }],
  } as CutJobDto;
}

describe('unlinked SVG rows in cut jobs', () => {
  it('shows source details beside ERP details without duplicating matches or inventing references', () => {
    const job = jobWith(placements);
    const before = JSON.stringify(job);
    const rows = cutJobInformationalDetails(job);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.orderName === '2900')).toMatchObject({
      orderId: null, detailNumber: 3, widthMm: 875, heightMm: 575, quantity: 2,
    });
    expect(rows.find(row => row.orderName === '2885')).toMatchObject({
      orderId: null, detailNumber: null, positionLabel: '# Test', sizeLabel: '500*492', sourceOnly: true,
    });
    expect(rows.some(row => row.orderName === '2895')).toBe(false);
    expect(JSON.stringify(job)).toBe(before);
  });

  it('keeps a real order reference when only its detail is unmatched', () => {
    const rows = cutJobInformationalDetails(jobWith({ ...placements, renderOnlyContours: [],
      pieces: [piece('svg-1', '2895', 11619, null)] }));
    expect(rows).toMatchObject([{ orderName: '2895', orderId: 11619, quantity: 1 }]);
  });

  it('keeps different source identities despite equal geometry', () => {
    const rows = cutJobInformationalDetails(jobWith({ ...placements, renderOnlyContours: [],
      pieces: [piece('svg-11', '2900', null, null), piece('svg-12', '2901', null, null)] }));
    expect(rows.map(row => [row.orderName, row.quantity])).toEqual([['2900', 1], ['2901', 1]]);
  });

  it('counts only the active variant, without repeating automatic layout rows', () => {
    const job = jobWith(placements);
    job.groups[0].manualLayout = { groupKey: '536', isActive: true, isStale: false, version: 1,
      sheets: [{ sheetIndex: 0, placements: { ...placements, renderOnlyContours: [], pieces: [piece('svg-manual', '2900', null, null)] } }] };
    expect(cutJobInformationalDetails(job)).toMatchObject([{ orderName: '2900', quantity: 1 }]);
  });
});
