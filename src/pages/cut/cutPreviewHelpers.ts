import type { CutGroupDto, CutJobItemDto, SheetPlacementPiece, SheetPlacements } from '../../api/types/cutApi.types';
import { orientPieceRect } from './cutLayoutGeometry';
import { applyAxisOrigin, type CutAxisOrigin } from './cutLayoutGeometry';
import { buildPieceLabelLines } from './pieceLabel';

export type CutPdfPreviewBlockReason = 'несохранённые изменения' | 'требуется пересчёт' | null;

export function cutPdfPreviewBlockReason(input: {
  isFrozenResult: boolean;
  hasUnsavedChanges: boolean;
  requiresRecalc: boolean;
}): CutPdfPreviewBlockReason {
  if (input.isFrozenResult) return null;
  if (input.hasUnsavedChanges) return 'несохранённые изменения';
  return input.requiresRecalc ? 'требуется пересчёт' : null;
}

export function shouldShowCutStaleBadge(input: {
  isFrozenResult: boolean;
  requiresRecalc: boolean;
  manualLayoutIsStale: boolean;
  manualLayoutIsActive: boolean;
}): boolean {
  if (input.isFrozenResult) return false;
  return input.requiresRecalc || (input.manualLayoutIsStale && input.manualLayoutIsActive);
}

/** Rounded mm side label, e.g. "2800 мм". */
export function formatSheetSide(mm: number): string {
  return `${Math.round(mm)} мм`;
}

/** Displayed mm extents of a sheet: [horizontal, vertical]. In landscape the
 *  sheet's height is the horizontal extent (used to label the preview sides). */
export function displayedSheetExtents(
  widthMm: number,
  heightMm: number,
  landscape: boolean,
): { horizontalMm: number; verticalMm: number } {
  return landscape
    ? { horizontalMm: heightMm, verticalMm: widthMm }
    : { horizontalMm: widthMm, verticalMm: heightMm };
}

/** localStorage key for a user's per-job sheet-orientation preference. */
export function sheetOrientationKey(userId: string, cutJobId: number): string {
  return `cut:sheet-orientation:${userId}:${cutJobId}`;
}

/** Parse a stored orientation value, preserving an explicit user choice and
 * using the caller's profile-specific fallback for absent/unknown values. */
export function parseStoredPortrait(raw: string | null, defaultPortrait = true): boolean {
  if (raw === 'portrait') return true;
  if (raw === 'landscape') return false;
  return defaultPortrait;
}

/** Read the per-user per-job portrait preference. */
export function loadSheetOrientationPortrait(
  userId: string,
  cutJobId: number,
  defaultPortrait = true,
): boolean {
  try {
    return parseStoredPortrait(
      localStorage.getItem(sheetOrientationKey(userId, cutJobId)),
      defaultPortrait,
    );
  } catch {
    return defaultPortrait;
  }
}

/** Persist the per-user per-job portrait preference. */
export function saveSheetOrientationPortrait(userId: string, cutJobId: number, portrait: boolean): void {
  try {
    localStorage.setItem(sheetOrientationKey(userId, cutJobId), portrait ? 'portrait' : 'landscape');
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

/** localStorage key for a user's per-job origin (top-left vs raw) preference. */
export function sheetOriginKey(userId: string, cutJobId: number): string {
  return `cut:sheet-origin-tl:${userId}:${cutJobId}`;
}

/** Parse a stored origin value. Default (absent / unknown) = top-left (true).
 *  Only the explicit 'raw' value selects the legacy 90° CW origin. */
export function parseStoredOriginTopLeft(raw: string | null): boolean {
  return raw !== 'raw';
}

/** Read the per-user per-job origin-top-left preference (default true). */
export function loadSheetOriginTopLeft(userId: string, cutJobId: number): boolean {
  try {
    return parseStoredOriginTopLeft(localStorage.getItem(sheetOriginKey(userId, cutJobId)));
  } catch {
    return true;
  }
}

/** Persist the per-user per-job origin-top-left preference. */
export function saveSheetOriginTopLeft(userId: string, cutJobId: number, originTopLeft: boolean): void {
  try {
    localStorage.setItem(sheetOriginKey(userId, cutJobId), originTopLeft ? 'tl' : 'raw');
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

export function sheetAxisOriginKey(userId: string, cutJobId: number): string {
  return `cut:sheet-axis-origin:${userId}:${cutJobId}`;
}

export function sheetAxisOriginPolicyKey(userId: string, cutJobId: number): string {
  return `cut:sheet-axis-origin-policy:${userId}:${cutJobId}`;
}

export function loadNonVacuumSheetAxisOrigin(
  userId: string,
  cutJobId: number,
): CutAxisOrigin | null {
  try {
    const stored = localStorage.getItem(sheetAxisOriginPolicyKey(userId, cutJobId));
    if (stored === 'v1:top-left') return 'top-left';
    if (stored === 'v1:bottom-left') return 'bottom-left';
    return null;
  } catch {
    return null;
  }
}

export function saveNonVacuumSheetAxisOrigin(
  userId: string,
  cutJobId: number,
  axisOrigin: CutAxisOrigin,
): void {
  try {
    localStorage.setItem(sheetAxisOriginPolicyKey(userId, cutJobId), `v1:${axisOrigin}`);
  } catch {
    // ignore storage failures
  }
}

export function parseStoredAxisOrigin(raw: string | null): CutAxisOrigin {
  return raw === 'top-left' || raw === 'tl' || raw === 'raw' ? 'top-left' : 'bottom-left';
}

export function loadSheetAxisOrigin(userId: string, cutJobId: number): CutAxisOrigin {
  try {
    const stored = localStorage.getItem(sheetAxisOriginKey(userId, cutJobId));
    if (stored !== null) return parseStoredAxisOrigin(stored);
    return parseStoredAxisOrigin(localStorage.getItem(sheetOriginKey(userId, cutJobId)));
  } catch {
    return 'bottom-left';
  }
}

export function saveSheetAxisOrigin(userId: string, cutJobId: number, axisOrigin: CutAxisOrigin): void {
  try {
    localStorage.setItem(sheetAxisOriginKey(userId, cutJobId), axisOrigin);
  } catch {
    // ignore storage failures
  }
}

export interface CutPieceTooltipRow {
  label: string;
  value: string;
}

export interface CutPieceOverlay {
  key: string;
  orderId: number | null;
  orderDeleted?: boolean;
  orderDetailId: number | null;
  detailNumber: number | null;
  vacuumOrientationWarning?: SheetPlacementPiece['vacuum_orientation_warning'];
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  tooltipRows: CutPieceTooltipRow[];
  /** Pre-built 3-line label for the on-screen preview overlay (always length 3). */
  labelLines: string[];
}

export function parseCutPieceDetailId(itemId: string): number | null {
  const match = /^det-(\d+)$/.exec(itemId);
  return match ? Number(match[1]) : null;
}

export function buildCutPieceTooltipRows(item: CutJobItemDto, piece: SheetPlacementPiece): CutPieceTooltipRow[] {
  const detail = item.detail;
  const rows: CutPieceTooltipRow[] = [
    { label: 'Заказ', value: formatTooltipValue(item.orderId) },
    ...(item.orderDeleted ? [{ label: 'Статус заказа', value: 'удалён' }] : []),
    { label: 'Позиция', value: formatTooltipValue(detail?.detailNumber) },
    { label: 'Экземпляр', value: formatTooltipValue(piece.instance) },
    { label: 'Кол-во в задании', value: formatTooltipValue(item.qty) },
  ];

  if (piece.vacuum_orientation_warning) {
    rows.push({ label: 'Предупреждение', value: piece.vacuum_orientation_warning.message });
  }

  if (detail) {
    rows.push(
      { label: 'Высота', value: formatTooltipValue(detail.height) },
      { label: 'Ширина', value: formatTooltipValue(detail.width) },
      { label: 'Количество', value: formatTooltipValue(detail.quantity) },
      { label: 'Площадь', value: formatTooltipArea(detail.area) },
      { label: 'Фрезеровка', value: formatTooltipValue(detail.millingTypeName) },
      { label: 'Обкат', value: formatTooltipValue(detail.edgeTypeName) },
      { label: 'Материал', value: formatTooltipValue(detail.materialName) },
      { label: 'Статус', value: formatTooltipValue(detail.productionStatusName) },
      { label: 'Примечание', value: formatTooltipValue(detail.note) },
      { label: 'Плёнка', value: formatTooltipValue(detail.filmName) },
    );
  }

  return rows;
}

function buildCutPieceLabelTooltipRows(piece: SheetPlacementPiece): CutPieceTooltipRow[] {
  const label = piece.label;
  const orderValue = label?.orderName?.trim() || label?.orderId || null;
  const rows: CutPieceTooltipRow[] = [
    { label: 'Заказ', value: formatTooltipValue(orderValue) },
    { label: 'Позиция', value: formatTooltipValue(label?.detailNumber ?? null) },
    { label: 'Экземпляр', value: formatTooltipValue(piece.instance) },
    { label: 'Высота', value: formatTooltipValue(label?.heightMm ?? piece.height_mm) },
    { label: 'Ширина', value: formatTooltipValue(label?.widthMm ?? piece.width_mm) },
    { label: 'Материал', value: formatTooltipValue(label?.materialName ?? null) },
  ];

  if (piece.vacuum_orientation_warning) {
    rows.push({ label: 'Предупреждение', value: piece.vacuum_orientation_warning.message });
  }

  return rows;
}

function pieceHasDisplayLabel(piece: SheetPlacementPiece): boolean {
  const label = piece.label;
  if (!label) return false;
  return Boolean(
    label.orderName?.trim() ||
    label.orderId != null ||
    label.detailNumber != null ||
    label.widthMm != null ||
    label.heightMm != null,
  );
}

export function buildSheetPieceOverlays(
  placements: SheetPlacements,
  items: readonly CutJobItemDto[],
  landscape: boolean,
  originTopLeft = false,
  axisOrigin: CutAxisOrigin = 'top-left',
): CutPieceOverlay[] {
  const itemByDetail = new Map(items.map((item) => [item.orderDetailId, item]));
  const itemByItemId = new Map(items.map((item) => [item.itemId ?? `det-${item.orderDetailId}`, item]));
  const sheetW = placements.sheet_width_mm;
  const sheetH = placements.sheet_height_mm;

  // A 4th "material" label line is added ONLY when this sheet mixes materials
  // (splitByMaterial off). On a single-material sheet the material is redundant
  // with the group/sheet header, so it is omitted. Mixing is keyed on the material
  // IDENTITY (sheet-material-type id, else legacy material id, else name) so two
  // catalog rows sharing a name still count as mixed — matches the backend render.
  const distinctMaterials = new Set<string>();
  for (const piece of placements.pieces) {
    const detailId = parseCutPieceDetailId(piece.item_id);
    const detail = (itemByItemId.get(piece.item_id) ?? (detailId === null ? undefined : itemByDetail.get(detailId)))?.detail;
    const labelMaterial = detail ? null : piece.label?.materialName?.trim();
    const nm = detail?.materialName?.trim() || labelMaterial;
    const key =
      detail?.sheetMaterialTypeId !== null && detail?.sheetMaterialTypeId !== undefined
        ? `s${detail.sheetMaterialTypeId}`
        : detail?.materialId !== null && detail?.materialId !== undefined
          ? `m${detail.materialId}`
          : nm
            ? `n${nm}`
            : null;
    if (key) distinctMaterials.add(key);
  }
  const sheetMixesMaterials = distinctMaterials.size > 1;

  return placements.pieces
    .map((piece) => {
      const detailId = parseCutPieceDetailId(piece.item_id);
      const item = itemByItemId.get(piece.item_id) ?? (detailId === null ? undefined : itemByDetail.get(detailId));
      const label = piece.label;
      if (!item && !pieceHasDisplayLabel(piece)) return null;

      const x = placements.trim_mm.left + piece.x_mm;
      const y = placements.trim_mm.top + piece.y_mm;
      // Single canonical transform (Codex R4 MAJOR #4): shared orientPieceRect
      // ensures FE preview and BE render cannot drift.  Coords are in full-sheet
      // space (trim already added above) as the T1 coordinate-space contract requires.
      const rect = applyAxisOrigin(orientPieceRect(
        { x, y, w: piece.width_mm, h: piece.height_mm },
        sheetW,
        sheetH,
        landscape,
        originTopLeft,
      ), axisOrigin, landscape);

      return {
        key: `${piece.item_id}:${piece.instance}`,
        orderId: item?.orderId ?? label?.orderId ?? null,
        orderDeleted: item?.orderDeleted === true,
        orderDetailId: item?.orderDetailId ?? label?.detailId ?? null,
        detailNumber: item?.detail?.detailNumber ?? label?.detailNumber ?? null,
        vacuumOrientationWarning: piece.vacuum_orientation_warning,
        leftPct: (rect.x / rect.vw) * 100,
        topPct: (rect.y / rect.vh) * 100,
        widthPct: (rect.w / rect.vw) * 100,
        heightPct: (rect.h / rect.vh) * 100,
        tooltipRows: item ? buildCutPieceTooltipRows(item, piece) : buildCutPieceLabelTooltipRows(piece),
        labelLines: buildPieceLabelLines({
          orderName: item?.orderName ?? label?.orderName ?? null,
          orderId: item?.orderId ?? label?.orderId ?? null,
          detailNumber: item?.detail?.detailNumber ?? label?.detailNumber ?? null,
          instance: piece.instance,
          qty: item?.qty ?? null,
          widthMm: piece.label?.widthMm ?? piece.width_mm,
          heightMm: piece.label?.heightMm ?? piece.height_mm,
          // 4th line only on mixed-material sheets.
          materialName: sheetMixesMaterials ? item?.detail?.materialName ?? label?.materialName ?? null : null,
        }),
      };
    })
    .filter((overlay): overlay is CutPieceOverlay => overlay !== null);
}

export interface CutSheetVacuumOrientationWarningItem {
  key: string;
  text: string;
}

export function buildSheetVacuumOrientationWarnings(
  placements: SheetPlacements,
  items: readonly CutJobItemDto[],
): CutSheetVacuumOrientationWarningItem[] {
  const itemByDetail = new Map(items.map((item) => [item.orderDetailId, item]));
  const itemByItemId = new Map(items.map((item) => [item.itemId ?? `det-${item.orderDetailId}`, item]));
  return placements.pieces
    .filter((piece) => piece.vacuum_orientation_warning)
    .map((piece) => {
      const detailId = parseCutPieceDetailId(piece.item_id);
      const item = itemByItemId.get(piece.item_id) ?? (detailId === null ? undefined : itemByDetail.get(detailId));
      const orderText = item ? `заказ ${formatTooltipValue(item.orderId)}` : 'заказ —';
      const detailNumber = item?.detail?.detailNumber ?? detailId;
      const detailName = item?.detail?.detailName?.trim();
      const detailText = [
        orderText,
        `позиция ${formatTooltipValue(detailNumber)}`,
        ...(detailName ? [detailName] : []),
        `экз. ${formatTooltipValue(piece.instance)}`,
      ].join(', ');
      return {
        key: `${piece.item_id}:${piece.instance}`,
        text: `${detailText}: ${piece.vacuum_orientation_warning!.message}`,
      };
    });
}

/**
 * Returns the sheets to use for the preview block, honouring the active
 * display variant.  When the operator switches to 'manual' (and the layout is
 * not stale), this returns `group.manualLayout.sheets`; otherwise it returns
 * the auto `group.sheets`.  'active' is treated the same as 'manual' for
 * forward-compatibility (the preview never produces 'active' today).
 */
export function selectVariantSheets(
  group: CutGroupDto,
  variant: 'auto' | 'manual' | 'active',
): { sheetIndex: number; placements: SheetPlacements }[] {
  if (
    (variant === 'manual' || variant === 'active') &&
    group.manualLayout &&
    !group.manualLayout.isStale
  ) {
    return group.manualLayout.sheets.map((s) => ({
      sheetIndex: s.sheetIndex,
      placements: s.placements,
    }));
  }
  return group.sheets.map((s) => ({
    sheetIndex: s.sheetIndex,
    placements: s.placements,
  }));
}

function formatTooltipValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatTooltipArea(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toFixed(2);
}
