import type {
  StatusAutomationActionType,
  StatusAutomationConditions,
  StatusAutomationEventType,
} from '../application/status-automation.types';

export interface StatusAutomationEventDescriptor {
  eventType: StatusAutomationEventType;
  title: string; // русское название для UI
  allowedConditions: ReadonlyArray<keyof StatusAutomationConditions>;
  allowedActions: ReadonlyArray<StatusAutomationActionType>;
}

const BASE_CONDITIONS: ReadonlyArray<keyof StatusAutomationConditions> = [
  'currentOrderStatusIn',
  'currentOrderStatusNotIn',
  'currentPaymentStatusIn',
  'currentPaymentStatusNotIn',
  'currentProductionStatusIn',
  'currentProductionStatusNotIn',
  'paidShareGte',
  'orderSourceIn',
];

const ALLOWED_ACTIONS: ReadonlyArray<StatusAutomationActionType> = [
  'change_order_status',
  'change_production_status',
  'change_details_production_status',
];

export const STATUS_AUTOMATION_EVENTS: ReadonlyArray<StatusAutomationEventDescriptor> = [
  {
    eventType: 'payment.created',
    title: 'Платёж создан',
    allowedConditions: [...BASE_CONDITIONS, 'firstPaymentOnly'],
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.payment_status_changed',
    title: 'Изменился статус оплаты',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.created',
    title: 'Заказ создан',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.status_changed',
    title: 'Изменился статус заказа',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.production_status_changed',
    title: 'Изменился статус производства',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
];

export function getEventDescriptor(eventType: string): StatusAutomationEventDescriptor | null {
  return STATUS_AUTOMATION_EVENTS.find((descriptor) => descriptor.eventType === eventType) ?? null;
}
