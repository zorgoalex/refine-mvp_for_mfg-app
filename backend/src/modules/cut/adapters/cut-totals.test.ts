import { describe, expect, it } from 'vitest';
import { roundTo2, mapTotalsRow, TOTALS_BY_JOB_SQL } from './cut-totals';

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
      positions: 2, details: 5, area: 4.5, sheets: 0, materialsCount: 2, filmsCount: 3,
    });
  });
  it('defaults missing/null columns to 0', () => {
    expect(mapTotalsRow({})).toEqual({ positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0 });
  });
});

describe('TOTALS_BY_JOB_SQL materials_count resolution', () => {
  it('joins cut_job and counts the override as one resolved material', () => {
    const sql = TOTALS_BY_JOB_SQL.replace(/\s+/g, ' ');
    // Override-aware: a job with a chosen sheet cuts all details on it -> count 1.
    expect(sql).toContain('JOIN cut_job cj ON cj.cut_job_id = i.cut_job_id');
    expect(sql).toContain('CASE WHEN cj.sheet_material_type_id IS NOT NULL THEN 1 ELSE COUNT(DISTINCT od.sheet_material_type_id) END AS materials_count');
    expect(sql).toContain('GROUP BY i.cut_job_id, cj.sheet_material_type_id');
  });
});
