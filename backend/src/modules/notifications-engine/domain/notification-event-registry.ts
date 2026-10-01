export type NotificationOwner = 'engine' | 'legacy_inline';
export type RecipientResolverKind =
  | 'order_manager'
  | 'stage_assignee'
  | 'group_participants'
  | 'workshop_head'
  | 'direction_head';
export type EventContextField = 'orderId' | 'clientId' | 'paymentId' | 'deadlineId';

/** Runtime-переключатель семейства событий; проверяется в момент обработки (план закупок §5.7 R5-3). */
export type NotificationFeatureFlag = 'procurementNotifications';

export interface NotificationEventDefinition {
  eventType: string;
  aggregateType: string;
  owner: NotificationOwner;
  contextFields: EventContextField[];
  supportedResolvers: RecipientResolverKind[];
  supportsOrderConditions: boolean;
  supportsDeadlineConditions: boolean;
  /** Условия закупа (`procurementChangeTypes`, `allocationRoles`) допустимы только для таких событий. */
  supportsProcurementConditions?: boolean;
  /** `source_type` записи in_app (по умолчанию `notification_rule`); свои типы фильтруются при чтении. */
  sourceType?: string;
  /** Допустимые каналы правил (по умолчанию — все); закуп — только in_app (решение пользователя В-4). */
  allowedChannels?: readonly ('in_app' | 'telegram')[];
  /** Флаг выключен в момент обработки → событие пропускается (skipped_disabled), уведомлений нет. */
  featureFlag?: NotificationFeatureFlag;
  /**
   * Видимость получателей: по умолчанию — базовая видимость заказа; `procurement` — текущие права/scope из матрицы
   * ролей + буквальное procurement.view (4б CR1-1).
   */
  recipientVisibility?: 'procurement';
  /** Событие старше этого — пропускается (skipped_stale): включение флага/реле не порождает лавину старых. */
  maxEventAgeHours?: number;
}

/** source_type уведомлений закупа по событиям заказа (фильтр scope при чтении, §5.7 R5-1). */
export const PROCUREMENT_ORDER_EVENT_SOURCE = 'procurement_order_event';
/** source_type сводки дефицита и «приход не распределён» (сервис закупа, ф.4б-2). */
export const PROCUREMENT_DIGEST_SOURCE = 'procurement_digest';
/** Уведомления закупа: читаются только с буквальным procurement.view и, у заказа, в его текущем scope. */
export const PROCUREMENT_NOTIFICATION_SOURCES: readonly string[] = [PROCUREMENT_ORDER_EVENT_SOURCE, PROCUREMENT_DIGEST_SOURCE];

const ORDER_RESOLVERS: RecipientResolverKind[] = [
  'order_manager',
  'stage_assignee',
  'group_participants',
  'workshop_head',
  'direction_head',
];

export const NOTIFICATION_EVENT_REGISTRY: Record<string, NotificationEventDefinition> = {
  'order.status_changed': {
    eventType: 'order.status_changed',
    aggregateType: 'order',
    owner: 'engine',
    contextFields: ['orderId', 'clientId'],
    supportedResolvers: ORDER_RESOLVERS,
    supportsOrderConditions: true,
    supportsDeadlineConditions: false,
  },
  'order.production_status_changed': {
    eventType: 'order.production_status_changed',
    aggregateType: 'order',
    owner: 'engine',
    contextFields: ['orderId', 'clientId'],
    supportedResolvers: ORDER_RESOLVERS,
    supportsOrderConditions: true,
    supportsDeadlineConditions: false,
  },
  'order.payment_status_changed': {
    eventType: 'order.payment_status_changed',
    aggregateType: 'order',
    owner: 'engine',
    contextFields: ['orderId', 'clientId', 'paymentId'],
    supportedResolvers: ORDER_RESOLVERS,
    supportsOrderConditions: true,
    supportsDeadlineConditions: false,
  },
  // Экран снабжения, ф.4б (§5.7): «материал пришёл по заказу» — правило на распределение прихода 1С.
  'order.resource_procurement_changed': {
    eventType: 'order.resource_procurement_changed',
    aggregateType: 'order',
    owner: 'engine',
    contextFields: ['orderId', 'clientId'],
    supportedResolvers: ORDER_RESOLVERS,
    supportsOrderConditions: true,
    supportsDeadlineConditions: false,
    supportsProcurementConditions: true,
    sourceType: PROCUREMENT_ORDER_EVENT_SOURCE,
    allowedChannels: ['in_app'],
    featureFlag: 'procurementNotifications',
    recipientVisibility: 'procurement',
    maxEventAgeHours: 24,
  },
  DEADLINE_EXPIRED: {
    eventType: 'DEADLINE_EXPIRED',
    aggregateType: 'deadline',
    owner: 'legacy_inline',
    contextFields: ['orderId', 'deadlineId'],
    supportedResolvers: ORDER_RESOLVERS,
    supportsOrderConditions: true,
    supportsDeadlineConditions: true,
  },
  GROUP_DEADLINE_OVERDUE: {
    eventType: 'GROUP_DEADLINE_OVERDUE',
    aggregateType: 'deadline',
    owner: 'legacy_inline',
    contextFields: ['orderId', 'deadlineId'],
    supportedResolvers: ['group_participants'],
    supportsOrderConditions: false,
    supportsDeadlineConditions: true,
  },
};

export function getEventDefinition(eventType: string): NotificationEventDefinition | undefined {
  return NOTIFICATION_EVENT_REGISTRY[eventType];
}

export function isEngineOwnedEvent(eventType: string): boolean {
  return getEventDefinition(eventType)?.owner === 'engine';
}

export function listConfigurableEventTypes(): NotificationEventDefinition[] {
  return Object.values(NOTIFICATION_EVENT_REGISTRY).filter(
    (d) => d.owner === 'engine' || d.supportsDeadlineConditions,
  );
}

/**
 * Returns the event definition with `owner` overridden by the supplied
 * runtime overrides. The static registry encodes the *default* ownership
 * (`legacy_inline` for deadline events); the engine uses this helper to
 * apply the operational cutover flag
 * (`BACKEND_NOTIFICATION_ENGINE_OWNS_DEADLINE`) at consumption time without
 * mutating the static shape. Non-deadline event types are returned
 * unchanged.
 */
export function withOwnerOverride(
  eventType: string,
  override: NotificationOwner | undefined,
): NotificationEventDefinition | undefined {
  const definition = NOTIFICATION_EVENT_REGISTRY[eventType];
  if (!definition || !override || definition.owner === override) {
    return definition;
  }
  return { ...definition, owner: override };
}
