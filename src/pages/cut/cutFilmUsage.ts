import type { CutFilmUsage, CutGroupDto, CutJobDto, SheetPlacements } from '../../api/types/cutApi.types';
import type { OrderDetail } from '../../types/orders';
import { calculateBathSheetFilmUsage, shouldShowBathMeterGuides } from './cutLayoutGeometry';
import { parseCutPieceDetailId } from './cutPreviewHelpers';

export interface OrderBathFilmUsageRow {
  filmId: number | null;
  filmName: string | null;
  linearMeters: number;
  sheets: number;
  cutJobIds: number[];
}

const linearMetersFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatFilmLinearMeters(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${linearMetersFormatter.format(n)} пог. м`;
}

export function totalFilmUsageMeters(usages: ReadonlyArray<Pick<CutFilmUsage, 'linearMeters'>> | undefined): number {
  return roundTo1((usages ?? []).reduce((total, row) => total + finiteNumber(row.linearMeters), 0));
}

export function filmUsageTooltip(usages: ReadonlyArray<CutFilmUsage> | undefined): string {
  const rows = (usages ?? []).filter((row) => finiteNumber(row.linearMeters) > 0);
  if (rows.length === 0) return '';
  return rows
    .map((row) => `${row.filmName?.trim() || 'Плёнка не указана'}: ${formatFilmLinearMeters(row.linearMeters)}`)
    .join('\n');
}

export function activeCutGroupSheets(group: CutGroupDto): Array<{ sheetIndex: number; placements: SheetPlacements }> {
  if (group.manualLayout?.isActive && !group.manualLayout.isStale) {
    return group.manualLayout.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }));
  }
  return group.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }));
}

export function computeOrderBathFilmUsage(
  details: ReadonlyArray<OrderDetail>,
  jobs: ReadonlyArray<CutJobDto>,
  filmNameById: ReadonlyMap<number, string> = new Map(),
): OrderBathFilmUsageRow[] {
  const orderDetailIds = new Set(
    details
      .map((detail) => detail.detail_id)
      .filter((id): id is number => Number.isInteger(id) && id > 0),
  );
  if (orderDetailIds.size === 0 || jobs.length === 0) return [];

  const orderDetailById = new Map<number, OrderDetail>();
  for (const detail of details) {
    if (detail.detail_id !== undefined) orderDetailById.set(detail.detail_id, detail);
  }

  const totals = new Map<string, {
    filmId: number | null;
    filmName: string | null;
    linearMeters: number;
    sheets: number;
    cutJobIds: Set<number>;
  }>();

  for (const job of jobs) {
    const itemByDetailId = new Map(job.items.map((item) => [item.orderDetailId, item]));
    for (const group of job.groups) {
      for (const sheet of activeCutGroupSheets(group)) {
        const relevantDetailIds = uniqueSheetDetailIds(sheet.placements).filter((detailId) => orderDetailIds.has(detailId));
        if (relevantDetailIds.length === 0) continue;

        const materialName = groupMaterialName(job, group)
          ?? firstOrderDetailMaterialName(relevantDetailIds, orderDetailById);
        if (!shouldShowBathMeterGuides({
          engineUsed: group.summary?.engine_used,
          materialName,
          materialWidthMm: sheet.placements.sheet_width_mm,
          materialHeightMm: sheet.placements.sheet_height_mm,
        })) {
          continue;
        }

        const usage = calculateBathSheetFilmUsage(sheet.placements);
        if (!usage) continue;

        const filmRefs = distinctFilmRefs(relevantDetailIds, orderDetailById, itemByDetailId, filmNameById);
        for (const film of filmRefs) {
          const key = film.filmId !== null ? `id:${film.filmId}` : `name:${film.filmName ?? ''}`;
          const current = totals.get(key);
          if (current) {
            current.linearMeters = roundTo1(current.linearMeters + usage.linearMeters);
            current.sheets += 1;
            current.cutJobIds.add(job.cutJobId);
          } else {
            totals.set(key, {
              filmId: film.filmId,
              filmName: film.filmName,
              linearMeters: usage.linearMeters,
              sheets: 1,
              cutJobIds: new Set([job.cutJobId]),
            });
          }
        }
      }
    }
  }

  return [...totals.values()]
    .map((row) => ({
      filmId: row.filmId,
      filmName: row.filmName,
      linearMeters: roundTo1(row.linearMeters),
      sheets: row.sheets,
      cutJobIds: [...row.cutJobIds].sort((a, b) => a - b),
    }))
    .sort((a, b) => (a.filmName ?? '').localeCompare(b.filmName ?? '', 'ru') || (a.filmId ?? 0) - (b.filmId ?? 0));
}

function uniqueSheetDetailIds(placements: SheetPlacements): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const piece of placements.pieces) {
    const detailId = parseCutPieceDetailId(piece.item_id);
    if (detailId === null || seen.has(detailId)) continue;
    seen.add(detailId);
    out.push(detailId);
  }
  return out;
}

function groupMaterialName(job: CutJobDto, group: CutGroupDto): string | null {
  for (const item of job.items) {
    if (item.cutGroupId !== group.cutGroupId) continue;
    const name = item.detail?.materialName?.trim();
    if (name) return name;
  }
  return null;
}

function firstOrderDetailMaterialName(
  detailIds: readonly number[],
  orderDetailById: ReadonlyMap<number, OrderDetail>,
): string | null {
  for (const detailId of detailIds) {
    const name = orderDetailById.get(detailId)?.material_name_resolved?.trim();
    if (name) return name;
  }
  return null;
}

function distinctFilmRefs(
  detailIds: readonly number[],
  orderDetailById: ReadonlyMap<number, OrderDetail>,
  itemByDetailId: ReadonlyMap<number, CutJobDto['items'][number]>,
  filmNameById: ReadonlyMap<number, string>,
): Array<{ filmId: number | null; filmName: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ filmId: number | null; filmName: string | null }> = [];
  for (const detailId of detailIds) {
    const orderDetail = orderDetailById.get(detailId);
    const item = itemByDetailId.get(detailId);
    const filmId = Number.isInteger(orderDetail?.film_id) && (orderDetail?.film_id ?? 0) > 0
      ? orderDetail!.film_id!
      : item?.detail?.filmId ?? null;
    const filmName = (filmId !== null ? filmNameById.get(filmId) : null)
      ?? item?.detail?.filmName
      ?? null;
    const cleanName = filmName?.trim() || null;
    if (filmId === null && cleanName === null) continue;
    const key = filmId !== null ? `id:${filmId}` : `name:${cleanName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filmId, filmName: cleanName });
  }
  return out;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundTo1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
