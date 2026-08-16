import { describe, expect, it } from 'vitest';
import { HDF_CLEARANCE_PER_SIDE_MM, HDF_TOTAL_CLEARANCE_MM, calculateHdfAreaM2, calculateOrderHdfDetail } from './order-hdf-calculations';

const source = {
  detailId: 10,
  detailNumber: 1,
  detailName: 'Facade',
  heightMm: 2733,
  widthMm: 583,
  quantity: 2,
  sheetMaterialTypeId: 5,
  sheetMaterialName: 'MDF',
  millingTypeId: 7,
  millingTypeName: 'выборка',
  productionStatusId: 1,
};

describe('calculateOrderHdfDetail', () => {
  it('uses the Excel formula edge * 2 plus explicit 0.5 mm clearance per side', () => {
    const row = calculateOrderHdfDetail(
      source,
      { hdfEnabled: true, hdfEdgeMm: 60 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );

    expect(row.status).toBe('ok');
    expect(row.hdfHeightMm).toBe(2612);
    expect(row.hdfWidthMm).toBe(462);
    expect(row.quantity).toBe(2);
    expect(row.areaM2).toBe(calculateHdfAreaM2(2612, 462, 2));
    expect(row.sourceSnapshotJson.clearancePerSideMm).toBe(HDF_CLEARANCE_PER_SIDE_MM);
    expect(row.sourceSnapshotJson.totalClearanceMm).toBe(HDF_TOTAL_CLEARANCE_MM);
  });

  it('supports the 67 mm two-stage edge from DB settings', () => {
    const row = calculateOrderHdfDetail(
      source,
      { hdfEnabled: true, hdfEdgeMm: 67 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );

    expect(row.status).toBe('ok');
    expect(row.hdfHeightMm).toBe(2598);
    expect(row.hdfWidthMm).toBe(448);
  });

  it('rejects too narrow HDF sides by configured threshold', () => {
    const row = calculateOrderHdfDetail(
      { ...source, widthMm: 130 },
      { hdfEnabled: true, hdfEdgeMm: 60 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );

    expect(row.status).toBe('too_narrow');
    expect(row.hdfWidthMm).toBe(9);
    expect(row.areaM2).toBe(0);
  });

  it('does not fall back to hardcoded threshold when config is absent', () => {
    const row = calculateOrderHdfDetail(
      source,
      { hdfEnabled: true, hdfEdgeMm: 60 },
      { thresholdMm: null, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );

    expect(row.status).toBe('config_missing');
    expect(row.configErrors).toContain('missing_threshold');
  });

  it('changes snapshot hash when HDF-driving fields change', () => {
    const first = calculateOrderHdfDetail(
      source,
      { hdfEnabled: true, hdfEdgeMm: 60 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );
    const second = calculateOrderHdfDetail(
      source,
      { hdfEnabled: true, hdfEdgeMm: 67 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );

    expect(second.sourceSnapshotHash).not.toBe(first.sourceSnapshotHash);
  });

  it('does not include production status in source geometry/config hash', () => {
    const first = calculateOrderHdfDetail(
      { ...source, productionStatusId: 1 },
      { hdfEnabled: true, hdfEdgeMm: 60 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );
    const second = calculateOrderHdfDetail(
      { ...source, productionStatusId: 5 },
      { hdfEnabled: true, hdfEdgeMm: 60 },
      { thresholdMm: 15, hdfSheetMaterialTypeId: 9, hdfSheetMaterialName: 'ХДФ', configRevision: 1 },
    );

    expect(second.sourceSnapshotHash).toBe(first.sourceSnapshotHash);
  });
});
