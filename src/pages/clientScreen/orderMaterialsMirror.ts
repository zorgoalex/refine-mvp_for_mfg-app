import { formatNumber } from '../../utils/numberFormat';

/**
 * The «Материалы» tab of the order form as display text: the film table and the sheet material
 * table with their totals, the way the tab draws them. Pure; the tab passes its own rows, its stock
 * answers and what the manager is allowed to see. A column the manager does not have (stock without
 * the right to see it) is `undefined` in every row and is never sent.
 */
export const MATERIAL_FILM_FIELDS = ['film_name', 'film_area', 'film_details', 'film_meters', 'film_sheets', 'film_cut_jobs', 'film_stock', 'film_coverage'] as const;
export const MATERIAL_SHEET_FIELDS = ['sheet_name', 'sheet_area', 'sheet_details', 'sheet_stock', 'sheet_coverage'] as const;
export type MaterialFilmField = typeof MATERIAL_FILM_FIELDS[number];
export type MaterialSheetField = typeof MATERIAL_SHEET_FIELDS[number];
type Value = string | null | undefined;

export interface OrderMaterialsMirror {
  /** Columns the manager's own tables have right now — stated, not guessed from the rows (a table may be empty). */
  filmColumns: MaterialFilmField[];
  sheetColumns: MaterialSheetField[];
  films: Array<{ key: string; values: Record<MaterialFilmField, Value> }>;
  sheets: Array<{ key: string; values: Record<MaterialSheetField, Value> }>;
}

export interface OrderMaterialsMirrorInput {
  filmRows: ReadonlyArray<{ key: string; filmId: number | null; name: string; totalArea: number; detailsCount: number; bathLinearMeters: number;
    bathSheets: number; cutJobIds: readonly number[] }>;
  sheetRows: ReadonlyArray<{ key: string; sheetMaterialTypeId: number; name: string; totalArea: number; detailsCount: number }>;
  cutJobNameById: ReadonlyMap<number, string>;
  /** Film stock by film id with its coverage label; null when the manager may not see the stock. */
  filmStock: ReadonlyMap<number, { stockLm: number | null | undefined; coverage: string }> | null;
  /** Sheet stock by sheet material type id as the tab's cell text; null when the manager may not see it. */
  sheetStock: ReadonlyMap<number, { text: string | null; coverage: string }> | null;
}

/** A name the tab could not resolve is shown by it as «ID: n»; the customer never gets an id. */
const cleanName = (name: string): string | null => (/^ID: \d+$/.test(name) ? null : name);

export function buildOrderMaterialsMirror(input: OrderMaterialsMirrorInput): OrderMaterialsMirror {
  const films = input.filmRows.map((row) => {
    const stock = row.filmId === null ? undefined : input.filmStock?.get(row.filmId);
    return {
      key: row.key,
      values: {
        film_name: cleanName(row.name),
        film_area: formatNumber(row.totalArea, 2),
        film_details: formatNumber(row.detailsCount, 0),
        film_meters: row.bathLinearMeters > 0 ? formatNumber(row.bathLinearMeters, 1) : null,
        film_sheets: row.bathSheets > 0 ? formatNumber(row.bathSheets, 0) : null,
        film_cut_jobs: row.cutJobIds.length ? row.cutJobIds.map((id) => input.cutJobNameById.get(id) ?? `#${id}`).join(', ') : null,
        film_stock: input.filmStock === null ? undefined : stock?.stockLm === null || stock?.stockLm === undefined ? null : formatNumber(stock.stockLm, 2),
        film_coverage: input.filmStock === null ? undefined : stock?.coverage ?? 'Нет данных',
      } satisfies Record<MaterialFilmField, Value>,
    };
  });
  const sum = <R,>(rows: readonly R[], pick: (row: R) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const meters = sum(input.filmRows, (row) => row.bathLinearMeters);
  const sheetsCount = sum(input.filmRows, (row) => row.bathSheets);
  if (films.length > 0) {
    films.push({
      key: 'total',
      values: {
        film_name: 'Итого',
        film_area: formatNumber(sum(input.filmRows, (row) => row.totalArea), 2),
        film_details: formatNumber(sum(input.filmRows, (row) => row.detailsCount), 0),
        film_meters: meters > 0 ? formatNumber(meters, 1) : null,
        film_sheets: sheetsCount > 0 ? formatNumber(sheetsCount, 0) : null,
        film_cut_jobs: '',
        film_stock: input.filmStock === null ? undefined : '',
        film_coverage: input.filmStock === null ? undefined : '',
      },
    });
  }
  const sheets = input.sheetRows.map((row) => {
    const stock = input.sheetStock?.get(row.sheetMaterialTypeId);
    return {
      key: row.key,
      values: {
        sheet_name: cleanName(row.name),
        sheet_area: formatNumber(row.totalArea, 2),
        sheet_details: formatNumber(row.detailsCount, 0),
        sheet_stock: input.sheetStock === null ? undefined : stock?.text ?? null,
        sheet_coverage: input.sheetStock === null ? undefined : stock?.coverage ?? 'Нет данных',
      } satisfies Record<MaterialSheetField, Value>,
    };
  });
  if (sheets.length > 0) {
    sheets.push({
      key: 'total',
      values: {
        sheet_name: 'Итого',
        sheet_area: formatNumber(sum(input.sheetRows, (row) => row.totalArea), 2),
        sheet_details: formatNumber(sum(input.sheetRows, (row) => row.detailsCount), 0),
        sheet_stock: input.sheetStock === null ? undefined : '',
        sheet_coverage: input.sheetStock === null ? undefined : '',
      },
    });
  }
  return {
    filmColumns: MATERIAL_FILM_FIELDS.filter((field) => input.filmStock !== null || (field !== 'film_stock' && field !== 'film_coverage')),
    sheetColumns: MATERIAL_SHEET_FIELDS.filter((field) => input.sheetStock !== null || (field !== 'sheet_stock' && field !== 'sheet_coverage')),
    films,
    sheets,
  };
}
