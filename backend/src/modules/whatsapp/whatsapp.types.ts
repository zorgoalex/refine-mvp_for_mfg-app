export type DeliveryState =
  | "pending"
  | "processing"
  | "retry_wait"
  | "sent"
  | "failed"
  | "unknown";

export interface WhatsAppConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  sessionName?: string;
  webhookSecret?: string;
  requestTimeoutMs: number;
  relayOwner: "none" | "in_process" | "external";
  relayPollIntervalMs: number;
  relayBatchSize: number;
  relayWorkerId: string;
  relayMaxAttempts: number;
  relayStaleLockMs: number;
  cleanupOwner: "none" | "in_process" | "external";
}

export interface InboundMessage {
  externalEventId: string;
  sessionName: string;
  chatId: string;
  text: string;
  requestId: string;
}
