import type { CutJobItemDto, SheetPlacementPiece, SheetPlacements } from '../../api/types/cutApi.types';

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

/** Parse a stored orientation value. Default (absent / unknown) = portrait. */
export function parseStoredPortrait(raw: string | null): boolean {
  return raw !== 'landscape';
}

/** Read the per-user per-job portrait preference (default portrait = true). */
export function loadSheetOrientationPortrait(userId: string, cutJobId: number): boolean {
  try {
    return parseStoredPortrait(localStorage.getItem(sheetOrientationKey(userId, cutJobId)));
  } catch {
    return true;
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

export interface CutPieceTooltipRow {
  label: string;
  value: string;
}

export interface CutPieceOverlay {
  key: string;
  orderId: number | null;
  orderDetailId: number | null;
  detailNumber: number | null;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  tooltipRows: CutPieceTooltipRow[];
}

const DETAIL_FIELD_LABELS: Record<string, string> = {
  detail_id: 'ID детали',
  detailId: 'ID детали',
  order_id: 'Заказ',
  orderId: 'Заказ',
  detail_number: 'Позиция',
  detailNumber: 'Позиция',
  detail_name: 'Наименование',
  detailName: 'Наименование',
  height: 'Высота',
  width: 'Ширина',
  quantity: 'Количество',
  area: 'Площадь',
  material_id: 'ID материала',
  materialId: 'ID материала',
  sheet_material_type_id: 'ID листового материала',
  sheetMaterialTypeId: 'ID листового материала',
  materialName: 'Материал',
  milling_type_id: 'ID фрезеровки',
  millingTypeId: 'ID фрезеровки',
  millingTypeName: 'Фрезеровка',
  edge_type_id: 'ID кромки',
  edgeTypeId: 'ID кромки',
  edgeTypeName: 'Кромка',
  film_id: 'ID плёнки',
  filmId: 'ID плёнки',
  filmName: 'Плёнка',
  priority: 'Приоритет',
  production_status_id: 'ID статуса производства',
  productionStatusId: 'ID статуса производства',
  productionStatusName: 'Статус производства',
  joint_order_id: 'Соединённый заказ',
  jointOrderId: 'Соединённый заказ',
  note: 'Примечание',
  link_cutting_file: 'Файл раскроя',
  linkCuttingFile: 'Файл раскроя',
  link_cutting_image_file: 'Изображение раскроя',
  linkCuttingImageFile: 'Изображение раскроя',
  link_cad_file: 'CAD-файл',
  linkCadFile: 'CAD-файл',
  link_pdf_file: 'PDF-файл',
  linkPdfFile: 'PDF-файл',
  delete_flag: 'Удалена',
  version: 'Версия',
  ref_key_1c: 'Ключ 1С',
  created_by: 'Кем создано',
  edited_by: 'Кем изменено',
  created_at: 'Создано',
  updated_at: 'Изменено',
  basis_project: 'Базис-проект',
  basis_data: 'Данные Базис',
};

export function parseCutPieceDetailId(itemId: string): number | null {
  const match = /^det-(\d+)$/.exec(itemId);
  return match ? Number(match[1]) : null;
}

export function buildCutPieceTooltipRows(item: CutJobItemDto, piece: SheetPlacementPiece): CutPieceTooltipRow[] {
  const rows: CutPieceTooltipRow[] = [
    { label: 'Заказ', value: formatTooltipValue(item.orderId) },
    { label: 'Позиция', value: formatTooltipValue(item.detail?.detailNumber) },
    { label: 'ID детали', value: formatTooltipValue(item.orderDetailId) },
    { label: 'Экземпляр', value: formatTooltipValue(piece.instance) },
    { label: 'Кол-во в задании', value: formatTooltipValue(item.qty) },
  ];

  const detailFields = item.detail?.detailFields;
  if (detailFields && typeof detailFields === 'object') {
    for (const [label, value] of Object.entries(detailFields)) {
      rows.push({ label: russianDetailFieldLabel(label), value: formatTooltipValue(value) });
    }
  } else if (item.detail) {
    for (const [label, value] of Object.entries(item.detail)) {
      if (label === 'detailFields') continue;
      rows.push({ label: russianDetailFieldLabel(label), value: formatTooltipValue(value) });
    }
  }

  return rows;
}

export function buildSheetPieceOverlays(
  placements: SheetPlacements,
  items: readonly CutJobItemDto[],
  landscape: boolean,
): CutPieceOverlay[] {
  const itemByDetail = new Map(items.map((item) => [item.orderDetailId, item]));
  const sheetW = placements.sheet_width_mm;
  const sheetH = placements.sheet_height_mm;

  return placements.pieces
    .map((piece) => {
      const detailId = parseCutPieceDetailId(piece.item_id);
      const item = detailId === null ? undefined : itemByDetail.get(detailId);
      if (!item) return null;

      const x = placements.trim_mm.left + piece.x_mm;
      const y = placements.trim_mm.top + piece.y_mm;
      const w = piece.width_mm;
      const h = piece.height_mm;
      const rect = landscape
        ? { x: sheetH - (y + h), y: x, w: h, h: w, vw: sheetH, vh: sheetW }
        : { x, y, w, h, vw: sheetW, vh: sheetH };

      return {
        key: `${piece.item_id}:${piece.instance}`,
        orderId: item.orderId,
        orderDetailId: item.orderDetailId,
        detailNumber: item.detail?.detailNumber ?? null,
        leftPct: (rect.x / rect.vw) * 100,
        topPct: (rect.y / rect.vh) * 100,
        widthPct: (rect.w / rect.vw) * 100,
        heightPct: (rect.h / rect.vh) * 100,
        tooltipRows: buildCutPieceTooltipRows(item, piece),
      };
    })
    .filter((overlay): overlay is CutPieceOverlay => overlay !== null);
}

function russianDetailFieldLabel(field: string): string {
  return DETAIL_FIELD_LABELS[field] ?? 'Дополнительное поле';
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
