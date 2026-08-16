/**
 * Pure helper for the manual-editor cross-sheet move guard: per-piece
 * material/film map keyed by freecut item id ("det-<orderDetailId>").
 *
 * Effective material mirrors the backend sheet-override semantics
 * (migration 040, applySheetOverride): a chosen «Лист раскроя» forces EVERY
 * detail onto that sheet at calculate time, so the guard must compare against
 * the override — comparing the detail's own sheet type would veto every
 * cross-sheet move on override jobs («другой материал листа»).
 */
export interface PieceMetaSourceItem {
  itemId?: string;
  orderDetailId: number;
  detail?: {
    sheetMaterialTypeId?: number | null;
    filmId?: number | null;
  } | null;
}

export interface PieceMeta {
  materialTypeId: number | null;
  filmId: number | null;
}

export function buildPieceMetaByItemId(
  items: readonly PieceMetaSourceItem[],
  jobSheetMaterialTypeId: number | null,
): Map<string, PieceMeta> {
  const m = new Map<string, PieceMeta>();
  for (const it of items) {
    m.set(it.itemId ?? `det-${it.orderDetailId}`, {
      materialTypeId: jobSheetMaterialTypeId ?? it.detail?.sheetMaterialTypeId ?? null,
      filmId: it.detail?.filmId ?? null,
    });
  }
  return m;
}
