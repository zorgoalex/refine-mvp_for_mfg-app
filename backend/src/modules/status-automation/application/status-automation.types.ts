import type { CurrentUser } from '../../../permissions/current-user';

export type StatusAutomationEventType =
  | 'payment.created'
  | 'order.payment_status_changed'
  | 'order.created'
  | 'order.updated'
  | 'order.planned_completion_date_changed'
  | 'order.status_changed'
  | 'order.production_status_changed'
  | 'mdf.order_machine_files_present';

export type StatusAutomationActionType =
  | 'change_order_status'
  | 'change_production_status'
  | 'change_details_production_status';

export type StatusAutomationOrigin = 'user' | 'automation';

export interface StatusAutomationConditions {
  currentOrderStatusIn?: number[];
  currentOrderStatusNotIn?: number[];
  currentPaymentStatusIn?: number[];
  currentPaymentStatusNotIn?: number[];
  currentProductionStatusIn?: number[];
  currentProductionStatusNotIn?: number[];
  paidShareGte?: number; // 0..100
  orderSourceIn?: Array<'manual' | 'bazis' | 'import'>;
  firstPaymentOnly?: boolean; // только payment.created
}

export interface StatusAutomationRule {
  id: number;
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number;
  conditions: StatusAutomationConditions;
  priority: number;
  isEnabled: boolean;
  version: number;
}

export interface StatusAutomationEvent {
  eventType: StatusAutomationEventType;
  origin: StatusAutomationOrigin;
  orderId: number;
  actor: CurrentUser;
  requestId: string;
  sourceIdempotencyKey?: string;
  paymentsCountAfter?: number;
  paymentStatusIdBefore?: number;
  paymentStatusIdAfter?: number;
  plannedCompletionDateBefore?: string | null;
  plannedCompletionDateAfter?: string | null;
}

export interface OrderAutomationState {
  orderId: number;
  orderStatusId: number;
  paymentStatusId: number;
  productionStatusId: number | null;
  productionStatusFromDetailsEnabled: boolean;
  finalAmount: number;
  paidAmount: number;
  source: 'manual' | 'bazis' | 'import';
  version: number;
  clientId: number | null;
}
