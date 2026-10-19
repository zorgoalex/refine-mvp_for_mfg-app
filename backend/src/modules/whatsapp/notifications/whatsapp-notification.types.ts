import type { PermissionName } from '../../../permissions/permissions';

export type WhatsAppNotificationLevel = 'info' | 'warning' | 'error';
export type WhatsAppNotificationState = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'skipped';
export type WhatsAppNotificationRecipient = { userId: number } | { chatId: string };

export interface WhatsAppNotificationRequest {
  /** The consumer's key: a repeat returns the same delivery, forever (rows are never deleted). */
  idempotencyKey: string;
  recipient: WhatsAppNotificationRecipient;
  /** First line, in bold. */
  title?: string | null;
  text: string;
  level: WhatsAppNotificationLevel;
  sourceType: string;
  sourceId?: string | number | null;
  /** Generated as `whatsapp-notification:<deliveryId>` when absent. */
  correlationId?: string | null;
  /** Not sent before (the consumer's quiet hours). Default: now. */
  notBefore?: Date | null;
  /** Not sent after; then `cancelled/expired`. Default: notBefore + 2 h; at most now + 7 days. */
  expiresAt?: Date | null;
  /** The user recipient must have this permission (literal membership) when queued and when sent. */
  requiredPermission?: PermissionName | null;
}

export interface WhatsAppNotificationResult {
  deliveryId: string;
  created: boolean;
  state: WhatsAppNotificationState;
  reason: string | null;
}

export interface WhatsAppNotificationStatus {
  deliveryId: string;
  state: WhatsAppNotificationState;
  reason: string | null;
  sentAt: string | null;
  updatedAt: string;
}

/** Reasons of a synchronous `skipped` (the row is still written: a repeat of the key returns it). */
export const WHATSAPP_NOTIFICATION_SKIP_REASONS = ['WHATSAPP_DISABLED', 'USER_INACTIVE', 'PERMISSION_MISSING', 'NO_WORK_PHONE'] as const;

export const WHATSAPP_NOTIFICATION_LIMITS = {
  bodyMax: 4096,
  titleMax: 200,
  keyMax: 200,
  defaultLifetimeMs: 2 * 60 * 60_000,
  maxLifetimeMs: 7 * 24 * 60 * 60_000,
  /** One notification message over all recipients per this many ms. */
  globalGapMs: 10_000,
  /** At most this many messages an hour to one recipient (user or chat). */
  perRecipientHourly: 20,
  /** A WAHA failure before anything was sent: retried after this. */
  retryMs: 60_000,
  /** Body and address cleared this long after the delivery finished. */
  purgeAfterMs: 30 * 24 * 60 * 60_000,
  statusesMax: 500,
} as const;
