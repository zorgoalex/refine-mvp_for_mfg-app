import type {
  StatusAutomationActionType,
  StatusAutomationConditions,
  StatusAutomationEventType,
} from '../application/status-automation.types';

export interface StatusAutomationEventDescriptor {
  eventType: StatusAutomationEventType;
  title: string; // русское название для UI
  group: 'order' | 'dates' | 'statuses' | 'payments' | 'production';
  description: string;
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
    group: 'payments',
    description: 'После добавления нового платежа к заказу.',
    allowedConditions: [...BASE_CONDITIONS, 'firstPaymentOnly'],
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.payment_status_changed',
    title: 'Изменился статус оплаты',
    group: 'payments',
    description: 'Когда изменился расчётный статус оплаты заказа.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.created',
    title: 'Заказ создан',
    group: 'order',
    description: 'После успешного создания заказа.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.updated',
    title: 'Заказ сохранён',
    group: 'order',
    description: 'После каждого успешного сохранения существующего заказа.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.planned_completion_date_changed',
    title: 'Изменилась плановая дата готовности',
    group: 'dates',
    description: 'Когда плановая дата готовности установлена, изменена или очищена.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.status_changed',
    title: 'Изменился статус заказа',
    group: 'statuses',
    description: 'Когда заказу назначен другой обычный статус.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'order.production_status_changed',
    title: 'Изменился статус производства',
    group: 'statuses',
    description: 'Когда заказу назначен другой производственный статус.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
  {
    eventType: 'mdf.order_machine_files_present',
    title: 'Файлы заказа на станке',
    group: 'production',
    description: 'Когда карточка в колонке «Файлы на станке» доски МДФ-работы содержит номер заказа.',
    allowedConditions: BASE_CONDITIONS,
    allowedActions: ALLOWED_ACTIONS,
  },
];

export function getEventDescriptor(eventType: string): StatusAutomationEventDescriptor | null {
  return STATUS_AUTOMATION_EVENTS.find((descriptor) => descriptor.eventType === eventType) ?? null;
}
