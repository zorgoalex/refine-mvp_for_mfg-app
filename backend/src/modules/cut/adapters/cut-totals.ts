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
 *  use od.quantity/od.area (NULL od -> 0 via SUM). films_count counts the
 *  DISTINCT non-null films among the job's details (film-less rows are NULL →
 *  excluded by COUNT(DISTINCT)). materials_count reflects the RESOLVED cut
 *  material, matching the EFFECTIVE grouping calculate produces:
 *   - split_by_material = false: every detail goes into ONE group → count = 1.
 *   - split_by_material = true (default): the DISTINCT effective sheet per detail,
 *     i.e. COALESCE(od.sheet_material_type_id, cut_job.sheet_material_type_id) —
 *     a no_sheet_spec detail resolves to the override sheet (calculate fills it),
 *     a materialed detail keeps its own sheet. NULL (no sheet, no override) is
 *     excluded by COUNT(DISTINCT) — that detail cannot be cut.
 *  Grouped by cut_job_id so one query serves a whole list. */
export const TOTALS_BY_JOB_SQL = `
  SELECT i.cut_job_id,
         COUNT(od.detail_id)                          AS positions,
         COALESCE(SUM(od.quantity), 0)                AS details,
         COALESCE(SUM(od.area * od.quantity), 0)      AS area,
         CASE WHEN NOT cj.split_by_material
              THEN 1
              ELSE COUNT(DISTINCT COALESCE(od.sheet_material_type_id, cj.sheet_material_type_id)) END AS materials_count,
         COUNT(DISTINCT od.film_id)                   AS films_count
  FROM cut_job_item i
  JOIN cut_job cj ON cj.cut_job_id = i.cut_job_id
  LEFT JOIN order_details od ON od.detail_id = i.order_detail_id AND od.delete_flag = false
  WHERE i.cut_job_id = ANY($1::bigint[]) AND i.is_active = true
  GROUP BY i.cut_job_id, cj.sheet_material_type_id, cj.split_by_material
`;

/** Frozen history backfill also counts archived rows still owned by a live group. */
export const TOTALS_FROZEN_ITEMS_BY_JOB_SQL = TOTALS_BY_JOB_SQL.replace(
  ' AND i.is_active = true',
  ` AND (
      i.is_active = true
      OR EXISTS (
        SELECT 1 FROM cut_group frozen_group
        WHERE frozen_group.cut_group_id = i.cut_group_id
          AND frozen_group.cut_job_id = i.cut_job_id
      )
    )`,
);

export const SHEETS_BY_JOB_SQL = `
  SELECT g.cut_job_id, COUNT(*) AS sheets
  FROM cut_group_sheet s
  JOIN cut_group g ON g.cut_group_id = s.cut_group_id
  WHERE g.cut_job_id = ANY($1::bigint[])
  GROUP BY g.cut_job_id
`;

/** Unique source detail material names for each job. This intentionally reads
 * the detail's own resolved material name and does not collapse to the job-level
 * sheet override, because the /cut list column answers "what details are inside
 * this job", not "what override sheet will be used for cutting". */
export const MATERIAL_NAMES_BY_JOB_SQL = `
  SELECT i.cut_job_id,
         ARRAY_AGG(DISTINCT COALESCE(smt.name, m.material_name) ORDER BY COALESCE(smt.name, m.material_name)) AS material_names
  FROM cut_job_item i
  LEFT JOIN order_details od ON od.detail_id = i.order_detail_id AND od.delete_flag = false
  LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
  LEFT JOIN materials m ON m.material_id = od.material_id
  WHERE i.cut_job_id = ANY($1::bigint[])
    AND i.is_active = true
    AND COALESCE(smt.name, m.material_name) IS NOT NULL
    AND btrim(COALESCE(smt.name, m.material_name)) <> ''
  GROUP BY i.cut_job_id
`;
