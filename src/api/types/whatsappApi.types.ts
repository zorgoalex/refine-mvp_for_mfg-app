export interface WhatsAppStatusDto {
  health: unknown;
  version: unknown;
  server: unknown;
  session: unknown;
  account: unknown;
  capping: unknown;
  timelock: unknown;
  restrictions: string[];
  diagnostics: {
    lastWebhookAt: string | null;
    queue: Record<string, number>;
  } | null;
  issues: Record<string, string | null>;
  degraded: boolean;
}

export interface WhatsAppTemplateDto {
  id: number;
  code: string;
  name: string;
  body: string;
  bodyMode?: 'text' | 'template';
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppRuleDto {
  id: number;
  code: string;
  name: string;
  matchMode: "contains_any" | "exact_any" | 'pattern_exact' | 'pattern_contains';
  replyMode?: 'plain' | 'quote';
  keywords: string[];
  templateId: number;
  templateName: string | null;
  priority: number;
  enabled: boolean;
  version: number;
}

export interface WhatsAppDeliveryJobDto {
  id: number;
  state:
    | "pending"
    | "processing"
    | "retry_wait"
    | "sent"
    | "failed"
    | "unknown";
  destination: string | null;
  body: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppAuditDto {
  auditId: string;
  event: string;
  entityType: string;
  entityId: string;
  username: string | null;
  requestId: string;
  source: string;
  createdAt: string;
}

export interface WhatsAppTechnicalLogDto {
  id: string;
  occurredAt: string;
  component: "backend" | "waha" | "webhook" | "relay" | "cleanup";
  level: "info" | "warn" | "error";
  eventCode: string;
  outcome: "started" | "succeeded" | "failed" | "observed";
  operation: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface WhatsAppTechnicalLogResponse {
  data: WhatsAppTechnicalLogDto[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface WhatsAppTechnicalLogQuery {
  page?: number;
  pageSize?: number;
  level?: "info" | "warn" | "error";
  component?: "backend" | "waha" | "webhook" | "relay" | "cleanup";
  outcome?: "started" | "succeeded" | "failed" | "observed";
  search?: string;
}

export interface WhatsAppTemplateInput {
  code: string;
  name: string;
  body: string;
  bodyMode?: 'text' | 'template';
  enabled: boolean;
}

export interface WhatsAppRuleInput {
  code: string;
  name: string;
  matchMode: "contains_any" | "exact_any" | 'pattern_exact' | 'pattern_contains';
  replyMode?: 'plain' | 'quote';
  keywords: string[];
  templateId: number;
  priority: number;
  enabled: boolean;
}

export interface WhatsAppReplyPreview {
  matched: boolean;
  captures: Record<string, string> | null;
  body: string | null;
  counterIsExample: boolean;
  timeZone: string;
}

export interface WhatsAppGroupDto {
  id: string;
  name: string;
  participantCount: number | null;
  announceOnly: boolean;
  communityParent: boolean;
  suspended: boolean;
}

export interface WhatsAppGroupsResponse {
  groups: WhatsAppGroupDto[];
  truncated: boolean;
  fetchedAt: string;
  cached: boolean;
}

export type WhatsAppNotificationState = "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled" | "skipped";
export type WhatsAppNotificationLevel = "info" | "warning" | "error";

export interface WhatsAppNotificationChannelDto {
  enabled: boolean;
  relayOwner: string;
  /** WhatsApp is on and this backend delivers; otherwise every new notification is skipped at once. */
  deliverable: boolean;
  /** «Остановить все рассылки» also holds notifications. */
  paused: boolean;
  epoch: number | null;
  epochStartedAt: string | null;
  queued: number;
  lastSentAt: string | null;
  last24h: Partial<Record<WhatsAppNotificationState, number>>;
  limits: { globalGapSeconds: number; perRecipientHourly: number; purgeAfterDays: number };
}

export type WhatsAppNotificationRecipientDto =
  | { kind: "user"; userId: number | null; username: string | null; employeeName: string | null; phoneMasked: string | null }
  | { kind: "chat"; chatId: string | null };

export interface WhatsAppNotificationDeliveryDto {
  deliveryId: string;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  sourceId: string | null;
  correlationId: string;
  idempotencyKey: string;
  level: WhatsAppNotificationLevel;
  title: string | null;
  /** The sent text; null after the content is cleared (30 days after the delivery finished). */
  text: string | null;
  recipient: WhatsAppNotificationRecipientDto;
  requiredPermission: string | null;
  state: WhatsAppNotificationState;
  reason: string | null;
  attempts: number;
  notBefore: string;
  expiresAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  purgedAt: string | null;
}

export interface WhatsAppNotificationJournalQuery {
  page?: number;
  pageSize?: number;
  state?: WhatsAppNotificationState;
  level?: WhatsAppNotificationLevel;
  recipientKind?: "user" | "chat";
  sourceType?: string;
  from?: string;
  to?: string;
  search?: string;
}

export interface WhatsAppNotificationJournalResponse {
  data: WhatsAppNotificationDeliveryDto[];
  /** `total` stops at 10 000: `totalCapped` — there are more. */
  pagination: { page: number; pageSize: number; total: number; totalCapped: boolean };
}
