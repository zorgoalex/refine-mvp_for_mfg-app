export type StatusAutomationEventType =
  | 'payment.created'
  | 'order.payment_status_changed'
  | 'order.created'
  | 'order.updated'
  | 'order.planned_completion_date_changed'
  | 'order.status_changed'
  | 'order.production_status_changed'
  | 'mdf.order_machine_files_present'
  | 'mdf.board.completed'
  | 'mdf.board.baths'
  | 'mdf.board.baths_ready'
  | 'mdf.board.baths_laminated';

export type StatusAutomationEventGroup = 'order' | 'dates' | 'statuses' | 'payments' | 'production';

export type StatusAutomationActionType =
  | 'change_order_status'
  | 'change_production_status'
  | 'change_details_production_status'
  | 'map_order_status_to_details_production_status'
  | 'map_production_status_to_order_status';

export interface StatusAutomationStatusMappingEntryDto {
  sourceStatusIds: number[];
  targetStatusId: number;
}

export interface StatusAutomationActionConfigDto {
  detailTransitionMode?: 'set_exact' | 'advance_only';
  statusMapping?: { entries: StatusAutomationStatusMappingEntryDto[] };
}

export type StatusAutomationOrderSource = 'manual' | 'bazis' | 'import';

export interface StatusAutomationConditionsDto {
  currentOrderStatusIn?: number[];
  currentOrderStatusNotIn?: number[];
  previousOrderStatusIn?: number[];
  currentPaymentStatusIn?: number[];
  currentPaymentStatusNotIn?: number[];
  currentProductionStatusIn?: number[];
  currentProductionStatusNotIn?: number[];
  paidShareGte?: number;
  orderSourceIn?: StatusAutomationOrderSource[];
  firstPaymentOnly?: boolean;
}

export interface StatusAutomationRuleDto {
  id: number;
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number | null;
  conditions: StatusAutomationConditionsDto;
  actionConfig?: StatusAutomationActionConfigDto;
  priority: number;
  isEnabled: boolean;
  version: number;
}

export interface StatusAutomationEventTypeDto {
  eventType: StatusAutomationEventType;
  title: string;
  group?: StatusAutomationEventGroup;
  description?: string;
  allowedConditions: string[];
  allowedActions: StatusAutomationActionType[];
}

export interface CreateStatusAutomationRuleRequest {
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number | null;
  conditions?: StatusAutomationConditionsDto;
  actionConfig?: StatusAutomationActionConfigDto;
  priority?: number;
  isEnabled?: boolean;
}

export interface UpdateStatusAutomationRuleRequest {
  name?: string;
  eventType?: StatusAutomationEventType;
  actionType?: StatusAutomationActionType;
  targetStatusId?: number | null;
  conditions?: StatusAutomationConditionsDto;
  actionConfig?: StatusAutomationActionConfigDto;
  priority?: number;
  isEnabled?: boolean;
  version: number;
}

export interface DeleteStatusAutomationRuleResponse {
  deleted: true;
}

export interface StatusAutomationOrderRefreshSummaryDto {
  orderId: number;
  orderFound: boolean;
  evaluatedRuleCount: number;
  matchedRuleCount: number;
  executedActionCount: number;
  skippedRuleCount: number;
  skippedActionCount: number;
}

export interface StatusAutomationRefreshFailureDto {
  orderId: number;
  code: string;
  message: string;
}

export interface StatusAutomationRecentOrdersRefreshResponse {
  cutoffDate: string;
  orderCount: number;
  processedOrderCount: number;
  failedOrderCount: number;
  failures: StatusAutomationRefreshFailureDto[];
  totals: Omit<StatusAutomationOrderRefreshSummaryDto, 'orderId' | 'orderFound'>;
  refreshedAt: string;
  requestId: string;
}
