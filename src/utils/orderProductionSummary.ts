import { productionSummaryLabel } from '../../backend/src/shared/production-status/production-summary';

export interface OrderProductionSummaryInput {
  production_status_name?: string | null;
  production_detail_count?: number;
  production_unassigned_count?: number;
  production_distinct_status_count?: number;
  productionStatusName?: string | null;
  productionDetailCount?: number;
  productionUnassignedCount?: number;
  productionDistinctStatusCount?: number;
}

/** Display only. Never use this label or the minimum stage as a readiness gate. */
export function orderProductionSummaryLabel(order: OrderProductionSummaryInput): string {
  return productionSummaryLabel({
    productionDetailCount: order.productionDetailCount ?? order.production_detail_count,
    productionUnassignedCount: order.productionUnassignedCount ?? order.production_unassigned_count,
    productionDistinctStatusCount: order.productionDistinctStatusCount ?? order.production_distinct_status_count,
    productionStatusName: order.productionStatusName ?? order.production_status_name,
  });
}

/** Compact visual label; the full explanation stays in the tooltip/export. */
export function orderProductionBadge(order: OrderProductionSummaryInput) {
  const total = order.productionDetailCount ?? order.production_detail_count;
  const missing = order.productionUnassignedCount ?? order.production_unassigned_count;
  const distinct = order.productionDistinctStatusCount ?? order.production_distinct_status_count;
  const name = order.productionStatusName ?? order.production_status_name;
  const verified = total !== undefined && missing !== undefined && distinct !== undefined;
  return {
    label: !verified ? 'Не проверен' : total === 0 ? 'Нет деталей'
      : missing > 0 ? 'Без статуса' : name || 'Без статуса',
    mixed: verified && total > 0 && (distinct > 1 || (missing > 0 && missing < total)),
    description: orderProductionSummaryLabel(order),
  };
}

/** Used by the live order detail view: SSE detail updates must not leave the badge stale. */
export function productionSummaryFromDetails(
  details: readonly { production_status_id?: number | null; delete_flag?: boolean | null }[],
) {
  const active = details.filter(detail => detail.delete_flag !== true);
  return {
    production_detail_count: active.length,
    production_unassigned_count: active.filter(detail => detail.production_status_id == null).length,
    production_distinct_status_count: new Set(active.flatMap(detail =>
      detail.production_status_id == null ? [] : [detail.production_status_id])).size,
  };
}

/** Match the same live/poll overlay used by detail rows, including explicit null. */
export function overlayDetailProductionStatuses<T extends {
  detail_id: number | string; production_status_id?: number | null;
}>(details: readonly T[], statuses: ReadonlyMap<number, number | null>): T[] {
  return details.map(detail => statuses.has(Number(detail.detail_id))
    ? { ...detail, production_status_id: statuses.get(Number(detail.detail_id)) }
    : detail);
}
