import type { RecipientResolverKind } from './notification-event-registry';

export type NotificationLevel = 'info' | 'warning' | 'error';
export const NOTIFICATION_CHANNELS = ['in_app', 'telegram', 'balloon'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
/** Внешние каналы — доставка через очередь доставок (`notification_channel_deliveries`); `in_app` и `balloon` — в приложении. */
export type ExternalNotificationChannel = Exclude<NotificationChannel, 'in_app' | 'balloon'>;
export function isExternalChannel(channel: NotificationChannel): channel is ExternalNotificationChannel {
  return channel !== 'in_app' && channel !== 'balloon';
}
/** Исчезновение балуна: `auto` — через 15 с, `persistent` — только крестиком (план 2026-10-03). */
export const BALLOON_MODES = ['auto', 'persistent'] as const;
export type BalloonMode = (typeof BALLOON_MODES)[number];
export type DeadlineNotificationEntityType = 'order' | 'order_stage';

/** Изменения закупа материала заказа (payload `changeType` события `order.resource_procurement_changed`). */
export const PROCUREMENT_CHANGE_TYPES = ['marked', 'unmarked', 'allocation_added', 'allocation_removed', 'allocation_linked', 'allocation_unlinked'] as const;
export type ProcurementChangeType = (typeof PROCUREMENT_CHANGE_TYPES)[number];
export const ALLOCATION_ROLES = ['receipt', 'payment'] as const;
export type AllocationRole = (typeof ALLOCATION_ROLES)[number];

export interface NotificationRuleConditions {
  /** Только эти изменения закупа (обязательно для событий закупа — правило не срабатывает на всё подряд). */
  procurementChangeTypes?: ProcurementChangeType[];
  /** Только распределения/связи этой роли; событие без роли при заданном условии не совпадает. */
  allocationRoles?: AllocationRole[];
  allowedFromOrderStatusIds?: number[];
  deadlineEntityTypes?: DeadlineNotificationEntityType[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
  /**
   * When `true` (the default), DEADLINE_EXPIRED-derived events are skipped
   * with `skipReason: 'stale_deadline_event'` if a newer deadline event has
   * superseded this one for the same order/deadline (mirrors the inline
   * `deadline-action-evaluator.ts` `requireCurrentDeadlineEvent` semantics).
   * For non-deadline event types `ctx.isCurrentDeadlineEvent` is always
   * `true`, so this condition is a no-op.
   */
  requireCurrentDeadlineEvent?: boolean;
}

export interface NotificationRuleRecipients {
  resolvers?: RecipientResolverKind[];
  roleCodes?: string[];
  userIds?: number[];
}

export interface NotificationRule {
  notificationRuleId: string;
  ruleCode: string;
  eventType: string;
  groupId: string | null;
  isEnabled: boolean;
  priority: number;
  level: NotificationLevel;
  channels: NotificationChannel[];
  /** Свойство исчезновения балуна; значимо только при канале `balloon`. */
  balloonMode: BalloonMode;
  conditions: NotificationRuleConditions;
  recipients: NotificationRuleRecipients;
  titleTemplate: string | null;
  messageTemplate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationEventContext {
  eventType: string;
  outboxEventId: string;
  aggregateType: string;
  aggregateId: string;
  orderId: number | null;
  clientId: number | null;
  paymentId: number | null;
  deadlineId: number | null;
  deadlineEntityType: DeadlineNotificationEntityType | null;
  /**
   * The deadline INSTANCE id (UUID string) for deadline-derived events, or
   * `null` for non-deadline events. This is the
   * `deadline.event.created` envelope's `aggregate_id` (= `event.deadlineId`
   * in the producer payload at `pg-deadline-repository.enqueueOutboxEvent`).
   * The numeric `deadlineId` field is kept for legacy consumers but is always
   * `null` for deadline events because the producer payload does not emit a
   * numeric `deadlineId`. Template authors should use `{orderId}` for the
   * parent order and resolve the deadline id via this field where needed.
   */
  deadlineInstanceId: string | null;
  /**
   * Effective group attribution for this event. Global rules ignore this;
   * group-scoped rules match only when their group id is present here.
   */
  groupIds: string[];
  orderStatusId: number | null;
  isOrderCompleted: boolean;
  /**
   * `true` when this deadline-derived event is for the CURRENT (latest)
   * DEADLINE_EXPIRED deadline_events row for the order/deadline pair, or
   * `true` (no staleness concept) for non-deadline events. Computed by
   * `PgNotificationContextBuilder` via the same query as
   * `PgDeadlineRepository.isDeadlineEventCurrentForOrder`. Used by
   * `evaluateRuleConditions`'s `requireCurrentDeadlineEvent` check to skip
   * stale DEADLINE_EXPIRED notifications/escalations after a newer deadline
   * event has superseded this one.
   */
  isCurrentDeadlineEvent: boolean;
  payload: Record<string, unknown>;
}
