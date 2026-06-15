export type NotificationOwner = 'engine' | 'legacy_inline';
export type RecipientResolverKind =
  | 'order_manager'
  | 'stage_assignee'
  | 'project_participants'
  | 'workshop_head'
  | 'direction_head';
export type EventContextField = 'orderId' | 'clientId' | 'paymentId' | 'deadlineId';

export interface NotificationEventDefinition {
  eventType: string;
  aggregateType: string;
  owner: NotificationOwner;
  contextFields: EventContextField[];
  supportedResolvers: RecipientResolverKind[];
  supportsOrderConditions: boolean;
  supportsDeadlineConditions: boolean;
}

const ORDER_RESOLVERS: RecipientResolverKind[] = [
  'order_manager',
  'stage_assignee',
  'project_participants',
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
  DEADLINE_EXPIRED: {
    eventType: 'DEADLINE_EXPIRED',
    aggregateType: 'deadline',
    owner: 'legacy_inline',
    contextFields: ['orderId', 'deadlineId'],
    supportedResolvers: ORDER_RESOLVERS,
    supportsOrderConditions: true,
    supportsDeadlineConditions: true,
  },
  PROJECT_DEADLINE_OVERDUE: {
    eventType: 'PROJECT_DEADLINE_OVERDUE',
    aggregateType: 'deadline',
    owner: 'legacy_inline',
    contextFields: ['orderId', 'deadlineId'],
    supportedResolvers: ['project_participants'],
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
