export type TelegramWorkerMessageStatus = 'observed' | 'used' | 'ingested' | 'skipped' | 'failed';
export type TelegramWorkerMessageType = 'svg' | 'dxf' | 'image' | 'gcode' | 'bot_reply' | 'text' | 'other';

export interface TelegramWorkerObservation {
  scanId: string;
  operationId: string | null;
  readSource: 'day_history' | 'reply_search' | 'reply_reconciliation';
  readOrdinal: number;
  observedAt: string;
  classificationCode: string;
  decisionCode: string | null;
  relatedSourceMessageId: string | null;
}

export interface TelegramWorkerStep {
  stepId: string;
  code: string;
  status: string;
  at: string;
  message: string;
}

export interface TelegramWorkerResponse {
  responseId: string;
  kind: 'backend_ingest' | 'telegram_reply';
  status: string;
  at: string;
  text?: string | null;
  telegramMessageId?: string | null;
  replyToMessageId?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface TelegramWorkerOperation {
  operationId: string;
  operationKey: string;
  scanId: string;
  operationType: 'message_processing' | 'telegram_reply';
  status: string;
  plannedAt: string;
  finishedAt: string | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  externalPacketKey: string | null;
  sourceVersion: string | null;
  packetId: string | null;
  cutJobId: string | null;
  cutResultNo: number | null;
  cuttingSequenceNo: number | null;
  backendApplied: boolean | null;
  backendStale: boolean | null;
  replyText: string | null;
  replyToMessageId: string | null;
  sessionSenderUserId: string | null;
  sentTelegramMessageId: string | null;
  reconciliationYieldedCount: number;
  reconciliationExhausted: boolean;
  reconciliationTruncated: boolean;
  reconciliationErrorCode: string | null;
  reconciliationWindowFrom: string | null;
  reconciliationWindowTo: string | null;
  steps: TelegramWorkerStep[];
  responses: TelegramWorkerResponse[];
}

export interface TelegramWorkerMessageLog {
  logId: string;
  logKey: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceThreadId: string | null;
  replyToMessageId: string | null;
  senderUserId: string | null;
  sourceCreatedAt: string;
  sourceEditedAt: string | null;
  workday: string;
  messageType: TelegramWorkerMessageType;
  filename: string | null;
  mimeType: string | null;
  messageText: string | null;
  outgoing: boolean;
  status: TelegramWorkerMessageStatus;
  reasonCode: string | null;
  reasonMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  relatedSourceMessageId: string | null;
  externalPacketKey: string | null;
  sourceVersion: string | null;
  packetId: string | null;
  cutJobId: string | null;
  cutResultNo: number | null;
  cuttingSequenceNo: number | null;
  backendApplied: boolean | null;
  backendStale: boolean | null;
  everIngested: boolean;
  firstObservedAt: string;
  lastObservedAt: string;
  observedCount: number;
  attemptCount: number;
  observations: TelegramWorkerObservation[];
  operations: TelegramWorkerOperation[];
}

export interface TelegramWorkerScan {
  scanId: string;
  sourceChatId: string;
  workday: string;
  status: 'running' | 'completed' | 'failed' | 'abandoned';
  startedAt: string;
  finishedAt: string | null;
  sessionUserId: string | null;
  dayYieldedCount: number;
  dayExhausted: boolean;
  dayTruncated: boolean;
  dayErrorCode: string | null;
  replySearchYieldedCount: number;
  replySearchExhausted: boolean;
  replySearchTruncated: boolean;
  replySearchErrorCode: string | null;
  svgCount: number;
  processedCount: number;
  ingestedCount: number;
  skippedCount: number;
  failedCount: number;
  parserVersion: string;
  workerVersion: string;
  canWriteChat: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TelegramWorkerAuditListResponse {
  data: TelegramWorkerMessageLog[];
  scans: TelegramWorkerScan[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface TelegramWorkerAuditQuery {
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sortDirection?: 'asc' | 'desc';
  status?: TelegramWorkerMessageStatus;
  messageType?: TelegramWorkerMessageType;
  reasonCode?: string;
  search?: string;
}

export type TelegramWorkerAuditExportQuery = Omit<TelegramWorkerAuditQuery, 'page' | 'pageSize' | 'sortDirection'>;
