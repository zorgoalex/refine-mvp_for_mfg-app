import type { OrderDetail, OrderHdfDetail } from '../../types/orders';
import { calculateOrderTotalArea } from '../../utils/orderArea';
import type { OrderBathFilmUsageRow } from '../cut/cutFilmUsage';

export interface OrderFilmMaterialRow {
  key: string;
  filmId: number | null;
  name: string;
  totalArea: number;
  detailsCount: number;
  bathLinearMeters: number;
  bathSheets: number;
  cutJobIds: number[];
}

export interface OrderSheetMaterialRow {
  key: string;
  sheetMaterialTypeId: number;
  name: string;
  totalArea: number;
  detailsCount: number;
}

interface FilmAccumulator {
  key: string;
  filmId: number | null;
  name: string;
  areaDetails: OrderDetail[];
  detailsCount: number;
  bathLinearMeters: number;
  bathSheets: number;
  cutJobIds: Set<number>;
}

interface SheetAccumulator {
  key: string;
  sheetMaterialTypeId: number;
  name: string;
  areaDetails: OrderDetail[];
  hdfArea: number;
  detailsCount: number;
}

export function buildUsableHdfAreaM2(hdfDetails: ReadonlyArray<OrderHdfDetail>): number {
  return roundTo2(hdfDetails.reduce((sum, detail) => {
    if (!isUsableHdfDetail(detail)) return sum;
    return sum + finiteNumber(detail.area_m2);
  }, 0));
}

export function buildOrderFilmMaterialRows(
  details: ReadonlyArray<OrderDetail>,
  bathFilmUsage: ReadonlyArray<OrderBathFilmUsageRow>,
  filmNameById: ReadonlyMap<number, string> = new Map(),
): OrderFilmMaterialRow[] {
  const rows = new Map<string, FilmAccumulator>();

  for (const detail of details) {
    const filmId = positiveId(detail.film_id);
    if (filmId === null) continue;
    const name = cleanName(filmNameById.get(filmId)) ?? `ID: ${filmId}`;
    const row = ensureFilmRow(rows, filmId, name);
    row.areaDetails.push(detail);
    row.detailsCount += 1;
  }

  for (const usage of bathFilmUsage) {
    const filmId = positiveId(usage.filmId);
    const name = cleanName(usage.filmName)
      ?? (filmId !== null ? cleanName(filmNameById.get(filmId)) : null)
      ?? 'Пленка не указана';
    const row = ensureFilmRow(rows, filmId, name);
    row.bathLinearMeters = roundTo1(row.bathLinearMeters + finiteNumber(usage.linearMeters));
    row.bathSheets += Math.max(0, Math.trunc(finiteNumber(usage.sheets)));
    for (const cutJobId of usage.cutJobIds) {
      if (Number.isInteger(cutJobId) && cutJobId > 0) row.cutJobIds.add(cutJobId);
    }
  }

  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      filmId: row.filmId,
      name: row.name,
      totalArea: calculateOrderTotalArea(row.areaDetails),
      detailsCount: row.detailsCount,
      bathLinearMeters: roundTo1(row.bathLinearMeters),
      bathSheets: row.bathSheets,
      cutJobIds: [...row.cutJobIds].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || (a.filmId ?? 0) - (b.filmId ?? 0));
}

export function buildOrderSheetMaterialRows(
  details: ReadonlyArray<OrderDetail>,
  materialNameOf: (detail: OrderDetail) => string | null | undefined,
  hdfDetails: ReadonlyArray<OrderHdfDetail> = [],
): OrderSheetMaterialRow[] {
  const rows = new Map<string, SheetAccumulator>();

  for (const detail of details) {
    const sheetMaterialTypeId = positiveId(detail.sheet_material_type_id);
    if (sheetMaterialTypeId === null) continue;
    const key = `sheet:${sheetMaterialTypeId}`;
    const row = rows.get(key) ?? {
      key,
      sheetMaterialTypeId,
      name: cleanName(materialNameOf(detail)) ?? `ID: ${sheetMaterialTypeId}`,
      areaDetails: [],
      hdfArea: 0,
      detailsCount: 0,
    };
    row.areaDetails.push(detail);
    row.detailsCount += 1;
    rows.set(key, row);
  }

  for (const hdfDetail of hdfDetails) {
    if (!isUsableHdfDetail(hdfDetail)) continue;
    const sheetMaterialTypeId = positiveId(hdfDetail.hdf_sheet_material_type_id);
    if (sheetMaterialTypeId === null) continue;
    const key = `sheet:${sheetMaterialTypeId}`;
    const row = rows.get(key) ?? {
      key,
      sheetMaterialTypeId,
      name: cleanName(hdfDetail.hdf_sheet_material_name) ?? `ID: ${sheetMaterialTypeId}`,
      areaDetails: [],
      hdfArea: 0,
      detailsCount: 0,
    };
    row.hdfArea = roundTo2(row.hdfArea + finiteNumber(hdfDetail.area_m2));
    row.detailsCount += Math.max(0, Math.trunc(finiteNumber(hdfDetail.quantity)));
    rows.set(key, row);
  }

  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      sheetMaterialTypeId: row.sheetMaterialTypeId,
      name: row.name,
      totalArea: roundTo2(calculateOrderTotalArea(row.areaDetails) + row.hdfArea),
      detailsCount: row.detailsCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.sheetMaterialTypeId - b.sheetMaterialTypeId);
}

function ensureFilmRow(
  rows: Map<string, FilmAccumulator>,
  filmId: number | null,
  name: string,
): FilmAccumulator {
  const key = filmId !== null ? `film:${filmId}` : `film-name:${name}`;
  const existing = rows.get(key);
  if (existing) return existing;
  const row: FilmAccumulator = {
    key,
    filmId,
    name,
    areaDetails: [],
    detailsCount: 0,
    bathLinearMeters: 0,
    bathSheets: 0,
    cutJobIds: new Set(),
  };
  rows.set(key, row);
  return row;
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundTo1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isUsableHdfDetail(detail: OrderHdfDetail): boolean {
  return detail.status === 'ok' && detail.is_stale !== true && finiteNumber(detail.area_m2) > 0;
}
