import { describe, expect, it } from 'vitest';
import {
  roundTo2,
  mapTotalsRow,
  TOTALS_BY_JOB_SQL,
  TOTALS_FROZEN_ITEMS_BY_JOB_SQL,
  MATERIAL_NAMES_BY_JOB_SQL,
} from './cut-totals';

describe('roundTo2', () => {
  it('rounds to 2 decimals (avoid .x5 float boundaries)', () => {
    expect(roundTo2(1.234)).toBe(1.23);
    expect(roundTo2(1.236)).toBe(1.24);
    expect(roundTo2(4.5)).toBe(4.5);
    expect(roundTo2(0)).toBe(0);
  });
});

describe('mapTotalsRow', () => {
  it('maps string/number aggregate columns into a rounded CutJobTotals', () => {
    expect(
      mapTotalsRow({ positions: '2', details: '5', area: '4.5', sheets: '0', materials_count: '2', films_count: '3' }),
    ).toEqual({
      positions: 2, details: 5, area: 4.5, sheets: 0, materialsCount: 2, filmsCount: 3, filmUsage: [],
    });
  });
  it('defaults missing/null columns to 0', () => {
    expect(mapTotalsRow({})).toEqual({ positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0, filmUsage: [] });
  });
});

describe('TOTALS_BY_JOB_SQL materials_count resolution', () => {
  it('mirrors the effective grouping: 1 when not split; else distinct COALESCE(detail sheet, override)', () => {
    const sql = TOTALS_BY_JOB_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('JOIN cut_job cj ON cj.cut_job_id = i.cut_job_id');
    expect(sql).toContain('COALESCE(SUM(i.qty), 0) AS details');
    expect(sql).toContain("WHEN i.source_type = 'order_hdf_detail' THEN (hdf.hdf_height_mm * hdf.hdf_width_mm / 1000000.0) * i.qty");
    expect(sql).toContain('ELSE od.area * i.qty');
    expect(sql).toContain("CASE WHEN i.source_type = 'order_hdf_detail' THEN hdf.hdf_sheet_material_type_id ELSE od.sheet_material_type_id END");
    expect(sql).toContain('CASE WHEN NOT cj.split_by_material THEN 1 ELSE COUNT(DISTINCT COALESCE(');
    expect(sql).toContain('GROUP BY i.cut_job_id, cj.sheet_material_type_id, cj.split_by_material');
  });
});

describe('TOTALS_FROZEN_ITEMS_BY_JOB_SQL', () => {
  it('includes archived group-owned rows but excludes unrelated released rows', () => {
    const sql = TOTALS_FROZEN_ITEMS_BY_JOB_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('i.is_active = true OR EXISTS');
    expect(sql).toContain('frozen_group.cut_group_id = i.cut_group_id');
    expect(sql).toContain('frozen_group.cut_job_id = i.cut_job_id');
    expect(sql).not.toContain('AND i.is_active = true GROUP BY');
  });
});

describe('MATERIAL_NAMES_BY_JOB_SQL', () => {
  it('aggregates unique detail material names without using the job sheet override', () => {
    const sql = MATERIAL_NAMES_BY_JOB_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('ARRAY_AGG(DISTINCT resolved_material.name ORDER BY resolved_material.name) AS material_names');
    expect(sql).toContain("LEFT JOIN order_details od ON od.detail_id = i.order_detail_id AND i.source_type = 'order_detail' AND od.delete_flag = false");
    expect(sql).toContain("LEFT JOIN order_hdf_details hdf ON hdf.order_hdf_detail_id = i.order_hdf_detail_id AND i.source_type = 'order_hdf_detail' AND hdf.delete_flag = false");
    expect(sql).toContain('LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id');
    expect(sql).toContain('LEFT JOIN sheet_material_types hdf_smt ON hdf_smt.sheet_material_type_id = hdf.hdf_sheet_material_type_id');
    expect(sql).toContain('LEFT JOIN materials m ON m.material_id = od.material_id');
    expect(sql).toContain('COALESCE(hdf_smt.name, smt.name, m.material_name) AS name');
    expect(sql).not.toContain('cj.sheet_material_type_id');
  });
});
