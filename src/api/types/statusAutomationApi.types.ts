export type StatusAutomationEventType =
  | 'payment.created'
  | 'order.payment_status_changed'
  | 'order.created'
  | 'order.status_changed'
  | 'order.production_status_changed';

export type StatusAutomationActionType =
  | 'change_order_status'
  | 'change_production_status'
  | 'change_details_production_status';

export type StatusAutomationOrderSource = 'manual' | 'bazis' | 'import';

export interface StatusAutomationConditionsDto {
  currentOrderStatusIn?: number[];
  currentOrderStatusNotIn?: number[];
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
  targetStatusId: number;
  conditions: StatusAutomationConditionsDto;
  priority: number;
  isEnabled: boolean;
  version: number;
}

export interface StatusAutomationEventTypeDto {
  eventType: StatusAutomationEventType;
  title: string;
  allowedConditions: string[];
  allowedActions: string[];
}

export interface CreateStatusAutomationRuleRequest {
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number;
  conditions?: StatusAutomationConditionsDto;
  priority?: number;
  isEnabled?: boolean;
}

export interface UpdateStatusAutomationRuleRequest {
  name?: string;
  eventType?: StatusAutomationEventType;
  actionType?: StatusAutomationActionType;
  targetStatusId?: number;
  conditions?: StatusAutomationConditionsDto;
  priority?: number;
  isEnabled?: boolean;
  version: number;
}

export interface DeleteStatusAutomationRuleResponse {
  deleted: true;
}
