export interface OrderProductionFlowStatus {
  production_status_id: number;
  production_status_name?: string | null;
  production_status_code?: string | null;
  sort_order?: number | null;
  is_active?: boolean | null;
}

export interface OrderProductionFlowDetail {
  production_status_id?: number | null;
  production_status_name?: string | null;
  quantity?: number | string | null;
  delete_flag?: boolean | null;
}

export interface OrderProductionFlowStage {
  key: string;
  statusId: number | null;
  /** production_status_code of the stage, when the reference is available. */
  code: string | null;
  name: string;
  /** Detail rows currently at this stage. */
  positions: number;
  /** Pieces (sum of quantity) currently at this stage. */
  quantity: number;
  /** positions / totalPositions, 0..1. */
  share: number;
}

export interface OrderProductionFlow {
  stages: OrderProductionFlowStage[];
  totalPositions: number;
  totalQuantity: number;
}

const toQuantity = (value: unknown): number => {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
};

/**
 * Display only: where the order details are right now, per production stage.
 * Stages are independent, so this never derives «passed» stages or readiness.
 */
export function buildOrderProductionFlow(
  details: readonly OrderProductionFlowDetail[],
  statuses: readonly OrderProductionFlowStatus[],
): OrderProductionFlow {
  const active = details.filter((detail) => detail.delete_flag !== true);
  const counts = new Map<number | null, { positions: number; quantity: number; name?: string }>();
  active.forEach((detail) => {
    const statusId = typeof detail.production_status_id === 'number' ? detail.production_status_id : null;
    const entry = counts.get(statusId) ?? { positions: 0, quantity: 0 };
    entry.positions += 1;
    entry.quantity += toQuantity(detail.quantity);
    if (!entry.name && typeof detail.production_status_name === 'string' && detail.production_status_name.trim()) {
      entry.name = detail.production_status_name.trim();
    }
    counts.set(statusId, entry);
  });

  const totalPositions = active.length;
  const totalQuantity = active.reduce((sum, detail) => sum + toQuantity(detail.quantity), 0);
  const codeById = new Map(statuses.map((status) => [
    status.production_status_id,
    status.production_status_code?.trim() || null,
  ]));
  const toStage = (statusId: number | null, name: string): OrderProductionFlowStage => {
    const entry = counts.get(statusId);
    const positions = entry?.positions ?? 0;
    return {
      key: statusId === null ? 'unassigned' : String(statusId),
      statusId,
      code: statusId === null ? null : codeById.get(statusId) ?? null,
      name,
      positions,
      quantity: entry?.quantity ?? 0,
      share: totalPositions > 0 ? positions / totalPositions : 0,
    };
  };

  const sorted = [...statuses].sort((left, right) => (
    (left.sort_order ?? Infinity) - (right.sort_order ?? Infinity)
    || left.production_status_id - right.production_status_id
  ));
  const known = new Set(sorted.map((status) => status.production_status_id));
  const stages: OrderProductionFlowStage[] = [];

  if (counts.has(null)) stages.push(toStage(null, 'Не назначен'));
  sorted.forEach((status) => {
    // Inactive stages stay visible only while details still sit in them.
    if (status.is_active === false && !counts.has(status.production_status_id)) return;
    stages.push(toStage(
      status.production_status_id,
      status.production_status_name?.trim() || counts.get(status.production_status_id)?.name || `Этап №${status.production_status_id}`,
    ));
  });
  [...counts.keys()]
    .filter((statusId): statusId is number => statusId !== null && !known.has(statusId))
    .sort((left, right) => left - right)
    .forEach((statusId) => {
      stages.push(toStage(statusId, counts.get(statusId)?.name || `Этап №${statusId}`));
    });

  return { stages, totalPositions, totalQuantity };
}
