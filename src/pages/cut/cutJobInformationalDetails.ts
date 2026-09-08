import type { CutJobDto } from '../../api/types/cutApi.types';
import { normalizeSvgRenderContours } from '@shared/svg-render-contours';
import { selectVariantSheets, parseCutPieceDetailId } from './cutPreviewHelpers';

export type InformationalCutDetailRow = {
  key: string;
  orderId: number | null;
  orderName: string | null;
  detailNumber: number | null;
  widthMm: number | null;
  heightMm: number | null;
  materialName: string | null;
  quantity: number;
  sourceOnly?: boolean;
  positionLabel?: string;
  sizeLabel?: string;
};

export function cutJobInformationalDetails(job: CutJobDto): InformationalCutDetailRow[] {
  const rows = new Map<string, InformationalCutDetailRow>();
  const linkedDetailIds = new Set(job.items.map((item) => item.orderDetailId));
  for (const group of job.groups) {
    for (const sheet of selectVariantSheets(group, 'active')) {
      for (const piece of sheet.placements.pieces) {
        const detailId = piece.label?.detailId ?? parseCutPieceDetailId(piece.item_id);
        if (detailId != null && linkedDetailIds.has(detailId)) continue;
        const label = piece.label;
        if (!label) continue;
        const orderName = label.orderName?.trim() || null;
        const widthMm = label.widthMm ?? piece.width_mm ?? null;
        const heightMm = label.heightMm ?? piece.height_mm ?? null;
        if (!orderName && !isPositiveInt(label.orderId) && label.detailNumber == null && widthMm == null && heightMm == null) continue;
        const materialName = label.materialName?.trim() || null;
        const key = [
          label.orderId ?? '',
          orderName ?? '',
          label.detailNumber ?? '',
          widthMm ?? '',
          heightMm ?? '',
          materialName ?? '',
        ].join(':');
        const existing = rows.get(key);
        if (existing) {
          existing.quantity += 1;
          continue;
        }
        rows.set(key, {
          key,
          orderId: isPositiveInt(label.orderId) ? label.orderId : null,
          orderName,
          detailNumber: label.detailNumber ?? null,
          widthMm,
          heightMm,
          materialName,
          quantity: 1,
        });
      }
      for (const contour of normalizeSvgRenderContours(sheet.placements.renderOnlyContours, {
        widthMm: sheet.placements.sheet_width_mm, heightMm: sheet.placements.sheet_height_mm,
      })) {
        const key = ['source', group.cutGroupId, sheet.sheetIndex, contour.sourceElementId, contour.xMm, contour.yMm].join(':');
        rows.set(key, {
          key,
          orderId: null,
          orderName: contour.labelLines[0] ?? null,
          detailNumber: null,
          positionLabel: contour.labelLines[1],
          sizeLabel: contour.labelLines[2],
          widthMm: contour.placedWidthMm,
          heightMm: contour.placedHeightMm,
          materialName: null,
          quantity: 1,
          sourceOnly: true,
        });
      }
    }
  }
  return [...rows.values()].sort((a, b) => (
    (a.orderName ?? String(a.orderId ?? '')).localeCompare(b.orderName ?? String(b.orderId ?? ''), 'ru', { numeric: true }) ||
    (a.detailNumber ?? 0) - (b.detailNumber ?? 0) ||
    (a.widthMm ?? 0) - (b.widthMm ?? 0) ||
    (a.heightMm ?? 0) - (b.heightMm ?? 0)
  ));
}


function isPositiveInt(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}
