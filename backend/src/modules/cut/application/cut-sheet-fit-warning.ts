import type { CutGrainRules } from './cut-config';
import {
  buildOptimizeRequest,
  freecutItemId,
  type FreecutParams,
} from './cut-freecut-mapping';

const FIT_EPSILON_MM = 1e-7;

export interface SelectedSheetFitItem {
  itemId?: string;
  orderDetailId: number | null;
  widthMm: number;
  heightMm: number;
  filmTexture: boolean | null;
}

export interface SelectedSheetSpec {
  sheetMaterialTypeId: number;
  widthMm: number;
  heightMm: number;
}

export interface SelectedSheetFitWarning {
  orderDetailId: number;
  reason: 'dimensions' | 'orientation';
  rotationForbidden: boolean;
  widthMm: number;
  heightMm: number;
  sheetMaterialTypeId: number;
  sheetWidthMm: number;
  sheetHeightMm: number;
  usableWidthMm: number;
  usableHeightMm: number;
}

/**
 * Preflights the exact per-job sheet override against the same resolved grain,
 * vacuum-direction and native-portrait rules used to build the Freecut request.
 * It deliberately returns one warning per detail position, not per quantity.
 */
export function computeSelectedSheetFitWarnings(input: {
  selectedSheet: SelectedSheetSpec | null;
  items: readonly SelectedSheetFitItem[];
  params: FreecutParams;
  grainRules: CutGrainRules;
  nativePortrait: boolean;
}): SelectedSheetFitWarning[] {
  if (input.selectedSheet === null) return [];

  const selectedSheet = input.selectedSheet;
  const warnings: SelectedSheetFitWarning[] = [];
  const request = buildOptimizeRequest({
    stock: {
      id: `smt-${selectedSheet.sheetMaterialTypeId}`,
      width_mm: selectedSheet.widthMm,
      height_mm: selectedSheet.heightMm,
    },
    items: input.items.map((item) => {
      const grainRule = item.filmTexture === true
        ? input.grainRules.textured
        : input.grainRules.plain;
      return {
        id: item.itemId ?? (item.orderDetailId === null ? 'unknown' : freecutItemId(item.orderDetailId)),
        width_mm: item.widthMm,
        height_mm: item.heightMm,
        qty: 1,
        ...grainRule,
      };
    }),
    params: input.params,
    includeSvg: false,
    nativePortrait: input.nativePortrait,
  });
  const stock = request.stock[0];
  const trim = request.params.trim_mm;
  const usableWidthMm = Math.max(0, stock.width_mm - trim.left - trim.right);
  const usableHeightMm = Math.max(0, stock.height_mm - trim.top - trim.bottom);
  const nativeAxesWereTransposed = input.nativePortrait
    && selectedSheet.widthMm > selectedSheet.heightMm;
  const displayUsableWidthMm = nativeAxesWereTransposed ? usableHeightMm : usableWidthMm;
  const displayUsableHeightMm = nativeAxesWereTransposed ? usableWidthMm : usableHeightMm;

  for (const [index, item] of input.items.entries()) {
    const effectiveItem = request.items[index];
    const directFits = fits(
      effectiveItem.width_mm,
      effectiveItem.height_mm,
      usableWidthMm,
      usableHeightMm,
    );
    if (directFits) continue;

    const rotatedFits = fits(
      effectiveItem.height_mm,
      effectiveItem.width_mm,
      usableWidthMm,
      usableHeightMm,
    );
    const rotationForbidden = effectiveItem.rotation === 'forbid';
    if (rotatedFits && !rotationForbidden) continue;

    warnings.push({
      orderDetailId: item.orderDetailId ?? 0,
      reason: rotatedFits && rotationForbidden ? 'orientation' : 'dimensions',
      rotationForbidden,
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      sheetMaterialTypeId: selectedSheet.sheetMaterialTypeId,
      sheetWidthMm: selectedSheet.widthMm,
      sheetHeightMm: selectedSheet.heightMm,
      usableWidthMm: displayUsableWidthMm,
      usableHeightMm: displayUsableHeightMm,
    });
  }

  return warnings;
}

function fits(widthMm: number, heightMm: number, usableWidthMm: number, usableHeightMm: number): boolean {
  return Number.isFinite(widthMm)
    && Number.isFinite(heightMm)
    && widthMm > 0
    && heightMm > 0
    && widthMm <= usableWidthMm + FIT_EPSILON_MM
    && heightMm <= usableHeightMm + FIT_EPSILON_MM;
}
