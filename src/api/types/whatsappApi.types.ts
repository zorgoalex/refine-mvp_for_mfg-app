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
