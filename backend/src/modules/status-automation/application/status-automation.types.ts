import type { CurrentUser } from '../../../permissions/current-user';

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

export type StatusAutomationActionType =
  | 'change_order_status'
  | 'change_production_status'
  | 'change_details_production_status'
  | 'map_order_status_to_details_production_status'
  | 'map_production_status_to_order_status';

export type StatusAutomationOrigin = 'user' | 'automation';

export interface StatusAutomationConditions {
  currentOrderStatusIn?: number[];
  currentOrderStatusNotIn?: number[];
  previousOrderStatusIn?: number[];
  currentPaymentStatusIn?: number[];
  currentPaymentStatusNotIn?: number[];
  currentProductionStatusIn?: number[];
  currentProductionStatusNotIn?: number[];
  paidShareGte?: number; // 0..100
  orderSourceIn?: Array<'manual' | 'bazis' | 'import'>;
  firstPaymentOnly?: boolean; // только payment.created
}

export interface StatusAutomationStatusMappingEntry {
  sourceStatusIds: number[];
  targetStatusId: number;
}

export interface StatusAutomationActionConfig {
  detailTransitionMode?: 'set_exact' | 'advance_only';
  statusMapping?: {
    entries: StatusAutomationStatusMappingEntry[];
  };
}

export interface StatusAutomationRule {
  id: number;
  name: string;
  eventType: StatusAutomationEventType;
  actionType: StatusAutomationActionType;
  targetStatusId: number | null;
  conditions: StatusAutomationConditions;
  actionConfig?: StatusAutomationActionConfig;
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
  orderStatusIdBefore?: number;
  orderStatusIdAfter?: number;
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
