import type { LatestOrderLabelsPreview, OrderLabelData } from '../../../../api/types/labelsApi.types';

type OrderLabelDetail = OrderLabelData['details'][number];
type LabelPreviewRow = NonNullable<LatestOrderLabelsPreview['rows']>[number];

export function readLabelPreviewRowDetailId(row: LabelPreviewRow | unknown): number | null {
  if (!row || typeof row !== 'object') return null;
  const detailId = (row as { detailId?: unknown }).detailId;
  if (typeof detailId === 'number' && Number.isFinite(detailId)) return detailId;
  if (typeof detailId === 'string' && detailId.trim() !== '') {
    const parsed = Number(detailId);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function buildFirstLabelPageIndexByDetailId(
  rows: readonly LabelPreviewRow[] | null | undefined,
  details: readonly Pick<OrderLabelDetail, 'detailId' | 'quantity'>[] | null | undefined,
): Map<number, number> {
  const fromRows = new Map<number, number>();
  for (const [index, row] of (rows ?? []).entries()) {
    const detailId = readLabelPreviewRowDetailId(row);
    if (detailId != null && !fromRows.has(detailId)) {
      fromRows.set(detailId, index);
    }
  }
  if (fromRows.size > 0) return fromRows;

  const fallback = new Map<number, number>();
  let pageIndex = 0;
  for (const detail of details ?? []) {
    const quantity = Math.max(0, Math.trunc(detail.quantity || 0));
    if (!fallback.has(detail.detailId) && quantity > 0) {
      fallback.set(detail.detailId, pageIndex);
    }
    pageIndex += quantity;
  }
  return fallback;
}

export function firstLabelPageIndexForDetail(
  detailId: number | null | undefined,
  rows: readonly LabelPreviewRow[] | null | undefined,
  details: readonly Pick<OrderLabelDetail, 'detailId' | 'quantity'>[] | null | undefined,
): number | null {
  if (detailId == null) return null;
  return buildFirstLabelPageIndexByDetailId(rows, details).get(detailId) ?? null;
}
