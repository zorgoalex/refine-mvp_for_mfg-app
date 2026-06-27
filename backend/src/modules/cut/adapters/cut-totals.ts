import type { CutJobTotals } from '../dto/cut.dto';

export function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export interface TotalsRow {
  positions?: string | number | null;
  details?: string | number | null;
  area?: string | number | null;
  sheets?: string | number | null;
  materials_count?: string | number | null;
  films_count?: string | number | null;
}

export function mapTotalsRow(row: TotalsRow): CutJobTotals {
  return {
    positions: num(row.positions),
    details: num(row.details),
    area: roundTo2(num(row.area)),
    sheets: num(row.sheets),
    materialsCount: num(row.materials_count),
    filmsCount: num(row.films_count),
  };
}

/** positions counts only live-detail rows (COUNT(od.detail_id)); details/area
 *  use od.quantity/od.area (NULL od -> 0 via SUM). materials_count/films_count
 *  count the DISTINCT non-null sheet materials / films among the job's details
 *  (no_sheet_spec / film-less rows are NULL → excluded by COUNT(DISTINCT)).
 *  Grouped by cut_job_id so one query serves a whole list. */
export const TOTALS_BY_JOB_SQL = `
  SELECT i.cut_job_id,
         COUNT(od.detail_id)                          AS positions,
         COALESCE(SUM(od.quantity), 0)                AS details,
         COALESCE(SUM(od.area * od.quantity), 0)      AS area,
         COUNT(DISTINCT od.sheet_material_type_id)    AS materials_count,
         COUNT(DISTINCT od.film_id)                   AS films_count
  FROM cut_job_item i
  LEFT JOIN order_details od ON od.detail_id = i.order_detail_id AND od.delete_flag = false
  WHERE i.cut_job_id = ANY($1::bigint[]) AND i.is_active = true
  GROUP BY i.cut_job_id
`;

export const SHEETS_BY_JOB_SQL = `
  SELECT g.cut_job_id, COUNT(*) AS sheets
  FROM cut_group_sheet s
  JOIN cut_group g ON g.cut_group_id = s.cut_group_id
  WHERE g.cut_job_id = ANY($1::bigint[])
  GROUP BY g.cut_job_id
`;
