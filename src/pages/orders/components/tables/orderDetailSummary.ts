import type { OrderDetail } from '../../../../types/orders';

export function calculateLiveOrderDetailCostTotal(
  details: readonly OrderDetail[],
  editingKey: number | string | null,
  editingValue: unknown,
): number {
  const liveValue = editingValue === null || editingValue === undefined || editingValue === ''
    ? 0
    : Number(editingValue);

  return details.reduce((total, detail) => {
    const detailKey = detail.temp_id ?? detail.detail_id ?? null;
    const value = editingKey !== null && detailKey === editingKey
      ? liveValue
      : Number(detail.detail_cost);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}
