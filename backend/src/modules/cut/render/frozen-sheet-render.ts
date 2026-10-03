import type { CutAxisOrigin } from '../../../shared/cut-geometry';
import { cutRenderStyleRuleProblem, type CutRenderStyleRule } from '../../../shared/cut-render-style';
import type { FreecutPlacement, SheetPlacementsJson } from '../application/cut-freecut-mapping';
import { buildBathProfileSheetSvg, buildSheetSvg, type BathPieceDetailInfo } from './sheet-svg';

/**
 * Compact frozen render of a stored cut result sheet (contract v2).
 *
 * v1 stored twelve finished views per sheet. v2 stores the piece coordinates (the sheet's
 * `placements`, unchanged) plus this model: every value the renderer asks a caller for at the
 * moment the result is saved — label lines, contour colour, bath details, the resolved style and
 * the bath meter guide flag. Any view is then drawn by `renderFrozenSheetView`, and the live
 * renderer draws through the same function, so a stored result and the live picture of the same
 * state cannot drift apart.
 */
export const FROZEN_SHEET_RENDER_V1 = 'cut_sheet_render_v1' as const;
export const FROZEN_SHEET_RENDER_V2 = 'cut_sheet_render_v2' as const;
/** The only view v2 keeps as SVG text: the label-map projection copies it into `base_svg`. */
export const FROZEN_SHEET_STORED_VIEW_KEY = 'r0:raw:top-left:labels-off';

export interface FrozenSheetPieceModel {
  itemId: string;
  instance: number;
  /** Exactly what the label callback returned, as lines (the renderer treats a string as one line). */
  label: string[];
  /** Contour colour; `null` = the style default (the renderer treats null and undefined alike). */
  fill: string | null;
  bath: BathPieceDetailInfo;
}

export interface FrozenSheetRenderModel {
  /** The resolved style used when the result was saved; `null` = the renderer's default style. */
  renderStyle: CutRenderStyleRule | null;
  showBathMeterGuides: boolean;
  pieces: FrozenSheetPieceModel[];
}

export interface FrozenSheetView {
  rotate90: boolean;
  originTopLeft: boolean;
  axisOrigin: CutAxisOrigin;
  showLabels: boolean;
}

export class FrozenSheetModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenSheetModelError';
  }
}

const pieceKey = (itemId: string, instance: number): string => `${itemId}#${instance}`;

/**
 * The v1 view key of a view request. Only rotated views distinguish the top-left transform, so the
 * flag is dropped for unrotated ones exactly as the v1 key did.
 */
export function frozenSheetViewKey(view: FrozenSheetView): string {
  return [
    view.rotate90 ? 'r90' : 'r0',
    view.rotate90 && view.originTopLeft ? 'tl' : 'raw',
    view.axisOrigin,
    view.showLabels ? 'labels-on' : 'labels-off',
  ].join(':');
}

/** Normalizes loose request flags the way the v1 view key did. */
export function frozenSheetView(view: {
  rotate90?: boolean;
  originTopLeft?: boolean;
  axisOrigin?: CutAxisOrigin;
  showLabels?: boolean;
}): FrozenSheetView {
  const rotate90 = view.rotate90 === true;
  return {
    rotate90,
    originTopLeft: rotate90 && view.originTopLeft === true,
    axisOrigin: view.axisOrigin ?? 'top-left',
    showLabels: view.showLabels !== false,
  };
}

/** All twelve views a v1 snapshot stored, in the v1 order. */
export const FROZEN_SHEET_VIEWS: readonly FrozenSheetView[] = (() => {
  const views: FrozenSheetView[] = [];
  for (const rotate90 of [false, true]) {
    for (const originTopLeft of rotate90 ? [false, true] : [false]) {
      for (const axisOrigin of ['top-left', 'bottom-left'] as const) {
        for (const showLabels of [false, true]) views.push({ rotate90, originTopLeft, axisOrigin, showLabels });
      }
    }
  }
  return views;
})();

/**
 * Captures, for every real piece of the sheet, what the callbacks answer now. Render-only contours
 * are not asked for: the renderer draws them from their own label lines and the default stroke.
 */
export function buildFrozenSheetRenderModel(input: {
  sheet: SheetPlacementsJson;
  labelFor: (piece: FreecutPlacement) => string | string[];
  fillFor: (piece: FreecutPlacement) => string | null | undefined;
  bathDetailInfoFor: (piece: FreecutPlacement) => BathPieceDetailInfo;
  renderStyle: CutRenderStyleRule | null;
  showBathMeterGuides: boolean;
}): FrozenSheetRenderModel {
  const seen = new Set<string>();
  const pieces = input.sheet.pieces.map((piece): FrozenSheetPieceModel => {
    const key = pieceKey(piece.item_id, piece.instance);
    if (seen.has(key)) throw new FrozenSheetModelError(`Деталь ${key} дважды на листе`);
    seen.add(key);
    const rawLabel = input.labelFor(piece);
    const label = Array.isArray(rawLabel) ? [...rawLabel] : [rawLabel];
    if (label.some((line) => typeof line !== 'string')) {
      throw new FrozenSheetModelError(`Подпись детали ${key} не текст`);
    }
    const fill = input.fillFor(piece);
    if (fill !== null && fill !== undefined && typeof fill !== 'string') {
      throw new FrozenSheetModelError(`Цвет детали ${key} не текст`);
    }
    const bath = input.bathDetailInfoFor(piece);
    for (const name of [bath.edgeTypeName, bath.millingTypeName]) {
      if (name !== null && name !== undefined && typeof name !== 'string') {
        throw new FrozenSheetModelError(`Данные ванны детали ${key} не текст`);
      }
    }
    // The renderer reads `name?.trim() || '—'` and `doweling === true`, so null for an absent
    // name and a strict boolean keep every drawn character.
    return {
      itemId: piece.item_id,
      instance: piece.instance,
      label,
      fill: fill ?? null,
      bath: {
        edgeTypeName: bath.edgeTypeName ?? null,
        millingTypeName: bath.millingTypeName ?? null,
        doweling: bath.doweling === true,
      },
    };
  });
  return {
    renderStyle: input.renderStyle,
    showBathMeterGuides: input.showBathMeterGuides,
    pieces,
  };
}

/** Draws one view of a sheet from its coordinates and model. A piece missing from the model throws. */
export function renderFrozenSheetView(
  sheet: SheetPlacementsJson,
  model: FrozenSheetRenderModel,
  view: FrozenSheetView,
): { svg: string; bathSvg: string } {
  const byKey = new Map(model.pieces.map((piece) => [pieceKey(piece.itemId, piece.instance), piece]));
  const pieceOf = (piece: FreecutPlacement): FrozenSheetPieceModel => {
    const found = byKey.get(pieceKey(piece.item_id, piece.instance));
    if (!found) {
      throw new FrozenSheetModelError(`Нет данных отрисовки детали ${pieceKey(piece.item_id, piece.instance)}`);
    }
    return found;
  };
  const labelFor = (piece: FreecutPlacement) => pieceOf(piece).label;
  const fillFor = (piece: FreecutPlacement) => pieceOf(piece).fill;
  const renderStyle = model.renderStyle ?? undefined;
  return {
    svg: buildSheetSvg({
      sheet,
      labelFor,
      fillFor,
      rotate90: view.rotate90,
      originTopLeft: view.originTopLeft,
      axisOrigin: view.axisOrigin,
      showLabels: view.showLabels,
      showBathMeterGuides: model.showBathMeterGuides,
      renderStyle,
    }),
    bathSvg: buildBathProfileSheetSvg({
      sheet,
      labelFor,
      fillFor,
      bathDetailInfoFor: (piece) => pieceOf(piece).bath,
      rotate90: view.rotate90,
      originTopLeft: view.originTopLeft,
      axisOrigin: view.axisOrigin,
      showBathMeterGuides: model.showBathMeterGuides,
      renderStyle,
    }),
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';

/**
 * Shape of a stored sheet render (both contracts) against its sheet's pieces. Returns the first
 * problem or null. Mirrors the SQL check `cut_result_snapshot_is_complete` (migration 231) so a
 * result that the database would reject is refused before the insert with a readable reason.
 */
export function frozenSheetRenderProblem(
  renderSnapshot: unknown,
  placements: SheetPlacementsJson,
): string | null {
  if (!isPlainObject(renderSnapshot)) return 'нет frozen render';
  if (!isPlainObject(renderSnapshot.pdfMeta)) return 'нет pdfMeta';
  if (!Array.isArray(renderSnapshot.pdfDetailRows)) return 'нет pdfDetailRows';
  const views = renderSnapshot.views;
  if (!isPlainObject(views)) return 'нет views';
  if (renderSnapshot.contractVersion === FROZEN_SHEET_RENDER_V1) {
    return Object.keys(views).length === FROZEN_SHEET_VIEWS.length ? null : 'не все виды v1';
  }
  if (renderSnapshot.contractVersion !== FROZEN_SHEET_RENDER_V2) return 'неизвестный контракт';
  if (!hasExactKeys(renderSnapshot, ['contractVersion', 'views', 'model', 'pdfMeta', 'pdfDetailRows'])) {
    return 'лишние или недостающие поля v2';
  }
  if (!hasExactKeys(views, [FROZEN_SHEET_STORED_VIEW_KEY])) return 'v2 хранит ровно один вид без подписей';
  const stored = views[FROZEN_SHEET_STORED_VIEW_KEY];
  if (!isPlainObject(stored) || !hasExactKeys(stored, ['svg']) || typeof stored.svg !== 'string' || stored.svg === '') {
    return 'вид без подписей должен содержать только svg';
  }
  const model = renderSnapshot.model;
  if (!isPlainObject(model) || !hasExactKeys(model, ['renderStyle', 'showBathMeterGuides', 'pieces'])) {
    return 'нет модели отрисовки';
  }
  if (model.renderStyle !== null) {
    const styleProblem = cutRenderStyleRuleProblem(model.renderStyle);
    if (styleProblem) return `некорректный стиль модели: ${styleProblem}`;
  }
  if (typeof model.showBathMeterGuides !== 'boolean') return 'некорректный признак сетки ванны';
  if (!Array.isArray(model.pieces)) return 'нет деталей модели';
  const modelKeys = new Set<string>();
  for (const piece of model.pieces) {
    if (!isPlainObject(piece) || !hasExactKeys(piece, ['itemId', 'instance', 'label', 'fill', 'bath'])) {
      return 'некорректная деталь модели';
    }
    if (typeof piece.itemId !== 'string' || piece.itemId === '') return 'деталь модели без itemId';
    if (typeof piece.instance !== 'number' || !Number.isInteger(piece.instance) || piece.instance <= 0) {
      return `некорректный экземпляр детали ${piece.itemId}`;
    }
    if (!Array.isArray(piece.label) || piece.label.some((line) => typeof line !== 'string')) {
      return `некорректная подпись детали ${piece.itemId}`;
    }
    if (!isNullableString(piece.fill)) return `некорректный цвет детали ${piece.itemId}`;
    const bath = piece.bath;
    if (
      !isPlainObject(bath) || !hasExactKeys(bath, ['edgeTypeName', 'millingTypeName', 'doweling'])
      || !isNullableString(bath.edgeTypeName) || !isNullableString(bath.millingTypeName)
      || typeof bath.doweling !== 'boolean'
    ) return `некорректные данные ванны детали ${piece.itemId}`;
    const key = pieceKey(piece.itemId, piece.instance);
    if (modelKeys.has(key)) return `деталь ${key} дважды в модели`;
    modelKeys.add(key);
  }
  const sheetKeys = new Set(placements.pieces.map((piece) => pieceKey(piece.item_id, piece.instance)));
  if (sheetKeys.size !== modelKeys.size || [...sheetKeys].some((key) => !modelKeys.has(key))) {
    return 'детали модели не совпадают с деталями листа';
  }
  return null;
}
