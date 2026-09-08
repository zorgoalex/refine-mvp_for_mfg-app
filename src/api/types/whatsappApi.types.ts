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
  degraded: boolean;
}

export interface WhatsAppTemplateDto {
  id: number;
  code: string;
  name: string;
  body: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppRuleDto {
  id: number;
  code: string;
  name: string;
  matchMode: "contains_any" | "exact_any";
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

export interface WhatsAppTemplateInput {
  code: string;
  name: string;
  body: string;
  enabled: boolean;
}

export interface WhatsAppRuleInput {
  code: string;
  name: string;
  matchMode: "contains_any" | "exact_any";
  keywords: string[];
  templateId: number;
  priority: number;
  enabled: boolean;
}
