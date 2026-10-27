import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { createProductionActionIdempotencyKey } from './productionActionsApi';

/** «Переделка» (production rounds) command API. Every command re-checks access and state on the backend. */

export type OrderReworkAvailability = 'available' | 'disabled_flag' | 'mdf_engine_unsupported' | 'mdf_cutover_in_progress';
export type OrderReworkAction = 'return' | 'start_in_production' | 'extend';

export interface OrderReworkReason {
  reasonId: number;
  code: string;
  name: string;
  requiresComment: boolean;
  sortOrder: number;
}

export interface OrderReworkReasonCatalogItem extends OrderReworkReason {
  isSystem: boolean;
  isActive: boolean;
  usedRounds: number;
  updatedAt: string;
}

export interface OrderReworkRoundDetail {
  detailId: number;
  detailNumber: number | null;
  fromProductionStatusId: number | null;
  fromProductionStatusName: string | null;
  fromProductionRound: number;
  toProductionStatusId: number;
  toProductionStatusName: string | null;
  addedAt: string;
  addedBySource: 'start' | 'extend';
}

export interface OrderReworkRound {
  roundNo: number;
  mode: 'after_ready' | 'in_production';
  source: 'manual' | 'auto_cut_repeat' | 'import';
  reasonId: number;
  reasonCode: string;
  reasonName: string;
  reasonIsSystem: boolean;
  reasonComment: string | null;
  startedAt: string;
  startedByUserId: number | null;
  startedByUsername: string | null;
  reasonClarifiedAt: string | null;
  closedAt: string | null;
  closeReason: 'ready' | 'issued' | 'completed' | 'false_positive' | null;
  /** «Переделка» 1.1: the round deadline (YYYY-MM-DD), its source and the order deadline before the round. */
  plannedCompletionDate?: string | null;
  plannedCompletionSource?: 'schedule' | 'manual' | null;
  fromPlannedCompletionDate?: string | null;
  details: OrderReworkRoundDetail[];
}

/** «Переделка» 1.1: the deadline the form pre-fills from «Схема этапов и сроки». */
export interface OrderReworkDeadlineSuggestion {
  suggestedDate: string | null;
  plannedOrderDays: number | null;
  stageIds: number[];
  scheduleConfigured: boolean;
  required: boolean;
  today: string;
  orderPlannedCompletionDate: string | null;
  roundPlannedCompletionDate: string | null;
}

export interface OrderReworkState {
  order: {
    orderStatusCode: string;
    /** Order version of the same snapshot as the rounds: the If-Match of commands from this state. */
    version: number;
    /** Backend-resolved: orders.rework + orders.update within the order scope (same gates as commands). */
    canRework: boolean;
    productionRound: number;
    lastRoundNo: number;
    openRoundNo: number | null;
    action: OrderReworkAction | null;
  };
  data: OrderReworkRound[];
}

export interface OrderReworkCommandResult {
  orderId: number;
  roundNo: number;
  action: 'started' | 'extended' | 'noop' | 'reason_clarified' | 'false_positive';
  version: number;
  detailIds: number[];
}

const commandHeaders = (version: number) => ({
  'Content-Type': 'application/json',
  'If-Match': `"${version}"`,
  'Idempotency-Key': createProductionActionIdempotencyKey('order-rework'),
});

const orderPath = (orderId: number) => backendApiPath(`/orders/${orderId}/rework`);

export const orderReworkApi = {
  availability(): Promise<{ availability: OrderReworkAvailability }> {
    return httpClient.get(backendApiPath('/order-rework/availability'));
  },
  reasons(): Promise<{ data: OrderReworkReason[] }> {
    return httpClient.get(backendApiPath('/order-rework/reasons'));
  },
  rounds(orderId: number): Promise<OrderReworkState> {
    return httpClient.get(`${orderPath(orderId)}/rounds`);
  },
  startOrExtend(
    orderId: number,
    version: number,
    body: {
      reasonId?: number;
      comment?: string | null;
      plannedCompletionDate?: string | null;
      details: Array<{ detailId: number; productionStatusId: number }>;
    },
  ): Promise<OrderReworkCommandResult> {
    return httpClient.request(orderPath(orderId), { method: 'POST', headers: commandHeaders(version), body: JSON.stringify(body) });
  },
  suggestDeadline(orderId: number, details: Array<{ detailId: number; productionStatusId: number }>): Promise<OrderReworkDeadlineSuggestion> {
    return httpClient.request(`${orderPath(orderId)}/deadline-suggestion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details }),
    });
  },
  clarifyReason(orderId: number, roundNo: number, version: number, body: { reasonId: number; comment?: string | null }): Promise<OrderReworkCommandResult> {
    return httpClient.request(`${orderPath(orderId)}/rounds/${roundNo}/reason`, {
      method: 'PATCH', headers: commandHeaders(version), body: JSON.stringify(body),
    });
  },
  falsePositive(orderId: number, roundNo: number, version: number): Promise<OrderReworkCommandResult> {
    return httpClient.request(`${orderPath(orderId)}/rounds/${roundNo}/false-positive`, {
      method: 'POST', headers: commandHeaders(version), body: JSON.stringify({}),
    });
  },
  reasonCatalog(): Promise<{ data: OrderReworkReasonCatalogItem[] }> {
    return httpClient.get(backendApiPath('/order-rework/reasons/catalog'));
  },
  createReason(body: { name: string; code?: string; requiresComment?: boolean; sortOrder?: number }): Promise<OrderReworkReasonCatalogItem> {
    return httpClient.request(backendApiPath('/order-rework/reasons'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  },
  updateReason(
    reasonId: number,
    body: { expectedUpdatedAt: string; name?: string; requiresComment?: boolean; sortOrder?: number; isActive?: boolean },
  ): Promise<OrderReworkReasonCatalogItem> {
    return httpClient.request(backendApiPath(`/order-rework/reasons/${reasonId}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  },
};

/** «Распилен ·2»: the round suffix is shown only for rounds after the original run. */
export function withRoundSuffix(label: string, round: number | null | undefined): string {
  return round && round > 1 ? `${label} ·${round}` : label;
}

export const REWORK_CLOSE_REASON_LABELS: Record<NonNullable<OrderReworkRound['closeReason']>, string> = {
  ready: 'готов к выдаче',
  issued: 'выдан',
  completed: 'завершён',
  false_positive: 'не переделка',
};
