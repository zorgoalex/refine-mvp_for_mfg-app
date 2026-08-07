import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

const POSTGRES_BIGINT_MIN = -(1n << 63n);
const POSTGRES_BIGINT_MAX = (1n << 63n) - 1n;
const telegramId = z.string().superRefine((value, context) => {
  if (value.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Telegram id must be canonical decimal' });
    return;
  }
  const parsed = BigInt(value);
  if (parsed < POSTGRES_BIGINT_MIN || parsed > POSTGRES_BIGINT_MAX) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Telegram id is outside PostgreSQL BIGINT range' });
  }
});
const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Date must be a real calendar date');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const operationKeySchema = z.string().regex(
  /^tgop:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[a-f0-9]{64}:(?:message_processing|telegram_reply):[1-9][0-9]{0,8}$/,
);

export const WORKER_AUDIT_CLASSIFICATION_CODES = [
  'message_svg', 'message_dxf', 'message_image', 'message_gcode',
  'message_bot_reply', 'message_text', 'message_other',
] as const;

export const WORKER_AUDIT_REASON_CODES = [
  'message_observed', 'message_classified', 'svg_selected', 'comment_selected',
  'image_selected', 'gcode_selected', 'source_unchanged', 'payload_unchanged',
  'unsupported_dxf', 'unsupported_message_type', 'no_svg_association',
  'svg_download_failed', 'svg_invalid_layout', 'image_download_failed', 'image_ignored',
  'gcode_download_failed', 'gcode_parse_failed', 'gcode_ignored', 'packet_built',
  'backend_ingest_succeeded', 'backend_ingest_failed', 'state_updated',
  'reply_selected', 'reply_invalid_number', 'reply_wrong_target', 'reply_foreign_sender',
  'reply_not_outgoing', 'reply_older_than_selected', 'reply_ambiguous',
  'reply_outside_business_window', 'reply_unrelated', 'reply_send_planned',
  'reply_send_succeeded', 'reply_send_failed', 'reconciliation_match',
  'reconciliation_wrong_target', 'reconciliation_wrong_text',
  'reconciliation_foreign_sender', 'reconciliation_not_outgoing',
  'reconciliation_outside_window', 'reconciliation_ambiguous',
  'reconciliation_incomplete', 'worker_restarted_before_scan_completion',
  'iterator_limit_reached', 'telegram_read_failed', 'audit_delivery_failed',
  'audit_spool_failed', 'backend_capability_failed', 'unexpected_worker_error',
] as const;

export const workerAuditReasonCodeSchema = z.enum(WORKER_AUDIT_REASON_CODES);
const optionalReasonCode = workerAuditReasonCodeSchema.nullable().optional();

export const workerAuditStepSchema = z.object({
  stepId: z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/),
  code: z.enum([
    'message_observed', 'classified', 'source_unchanged', 'svg_download', 'svg_parse',
    'image_download', 'gcode_download', 'gcode_parse', 'packet_build', 'payload_unchanged',
    'audit_spooled', 'backend_ingest', 'state_updated', 'reply_search', 'reply_send',
  ]),
  status: z.enum(['started', 'succeeded', 'skipped', 'failed']),
  at: dateTime,
  message: z.string().trim().max(500),
}).strict();

export const workerAuditResponseSchema = z.object({
  responseId: z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/),
  kind: z.enum(['backend_ingest', 'telegram_reply']),
  status: z.enum(['planned', 'succeeded', 'failed', 'reconciled', 'ambiguous', 'incomplete']),
  at: dateTime,
  text: optionalText(500),
  telegramMessageId: telegramId.nullable().optional(),
  replyToMessageId: telegramId.nullable().optional(),
  httpStatus: z.number().int().min(100).max(599).nullable().optional(),
  errorCode: optionalReasonCode,
  errorMessage: optionalText(500),
}).strict();

const scanSchema = z.object({
  scanId: uuid,
  sourceChatId: telegramId,
  workday: dateOnly,
  status: z.enum(['running', 'completed', 'failed', 'abandoned']),
  startedAt: dateTime,
  finishedAt: dateTime.nullable().optional(),
  sessionUserId: telegramId.nullable().optional(),
  dayYieldedCount: z.number().int().min(0).max(100000),
  dayExhausted: z.boolean(),
  dayTruncated: z.boolean(),
  dayErrorCode: optionalReasonCode,
  replySearchYieldedCount: z.number().int().min(0).max(100000),
  replySearchExhausted: z.boolean(),
  replySearchTruncated: z.boolean(),
  replySearchErrorCode: optionalReasonCode,
  svgCount: z.number().int().min(0).max(100000),
  processedCount: z.number().int().min(0).max(100000),
  ingestedCount: z.number().int().min(0).max(100000),
  skippedCount: z.number().int().min(0).max(100000),
  failedCount: z.number().int().min(0).max(100000),
  parserVersion: z.string().trim().min(1).max(120),
  workerVersion: z.string().trim().min(1).max(120),
  canWriteChat: z.boolean(),
  errorCode: optionalReasonCode,
  errorMessage: optionalText(1000),
}).strict();

const messageSchema = z.object({
  logKey: z.string().regex(/^tglog:raw-v1:[a-f0-9]{64}$/),
  rawSourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sanitizerVersion: z.string().trim().min(1).max(60),
  sourceChatId: telegramId,
  sourceMessageId: telegramId,
  sourceThreadId: telegramId.nullable().optional(),
  replyToMessageId: telegramId.nullable().optional(),
  senderUserId: telegramId.nullable().optional(),
  sourceCreatedAt: dateTime,
  sourceEditedAt: dateTime.nullable().optional(),
  workday: dateOnly,
  messageType: z.enum(['svg', 'dxf', 'image', 'gcode', 'bot_reply', 'text', 'other']),
  filename: optionalText(255),
  mimeType: optionalText(120),
  messageText: optionalText(2000),
  outgoing: z.boolean(),
  status: z.enum(['observed', 'used', 'ingested', 'skipped', 'failed']),
  reasonCode: optionalReasonCode,
  reasonMessage: optionalText(1000),
  errorCode: optionalReasonCode,
  errorMessage: optionalText(1000),
  relatedSourceMessageId: telegramId.nullable().optional(),
  externalPacketKey: optionalText(200),
  sourceVersion: telegramId.nullable().optional(),
  packetId: uuid.nullable().optional(),
  cutJobId: telegramId.nullable().optional(),
  cutResultNo: z.number().int().positive().nullable().optional(),
  cuttingSequenceNo: z.number().int().positive().max(999999).nullable().optional(),
  backendApplied: z.boolean().nullable().optional(),
  backendStale: z.boolean().nullable().optional(),
  observedAt: dateTime,
  decisionAt: dateTime.nullable().optional(),
}).strict();

const operationSchema = z.object({
  operationKey: operationKeySchema,
  scanId: uuid,
  logKey: z.string().regex(/^tglog:raw-v1:[a-f0-9]{64}$/),
  operationType: z.enum(['message_processing', 'telegram_reply']),
  status: z.enum(['planned', 'succeeded', 'skipped', 'failed', 'reconciled', 'ambiguous', 'incomplete']),
  plannedAt: dateTime,
  finishedAt: dateTime.nullable().optional(),
  reasonCode: optionalReasonCode,
  reasonMessage: optionalText(1000),
  errorCode: optionalReasonCode,
  errorMessage: optionalText(1000),
  externalPacketKey: optionalText(200),
  sourceVersion: telegramId.nullable().optional(),
  packetId: uuid.nullable().optional(),
  cutJobId: telegramId.nullable().optional(),
  cutResultNo: z.number().int().positive().nullable().optional(),
  cuttingSequenceNo: z.number().int().positive().max(999999).nullable().optional(),
  backendApplied: z.boolean().nullable().optional(),
  backendStale: z.boolean().nullable().optional(),
  replyText: optionalText(500),
  replyToMessageId: telegramId.nullable().optional(),
  sessionSenderUserId: telegramId.nullable().optional(),
  sentTelegramMessageId: telegramId.nullable().optional(),
  reconciliationYieldedCount: z.number().int().min(0).max(100000).default(0),
  reconciliationExhausted: z.boolean().default(false),
  reconciliationTruncated: z.boolean().default(false),
  reconciliationErrorCode: optionalReasonCode,
  reconciliationWindowFrom: dateTime.nullable().optional(),
  reconciliationWindowTo: dateTime.nullable().optional(),
  steps: z.array(workerAuditStepSchema).max(64),
  responses: z.array(workerAuditResponseSchema).max(16),
}).strict();

const observationSchema = z.object({
  scanId: uuid,
  logKey: z.string().regex(/^tglog:raw-v1:[a-f0-9]{64}$/),
  operationKey: operationKeySchema.nullable().optional(),
  sourceChatId: telegramId,
  sourceMessageId: telegramId,
  observedAt: dateTime,
  readSource: z.enum(['day_history', 'reply_search', 'reply_reconciliation']),
  readOrdinal: z.number().int().positive().max(100000),
  classificationCode: z.enum(WORKER_AUDIT_CLASSIFICATION_CODES),
  decisionCode: optionalReasonCode,
  relatedSourceMessageId: telegramId.nullable().optional(),
}).strict().superRefine((value, context) => {
  const reconciliation = value.readSource === 'reply_reconciliation';
  if (reconciliation !== Boolean(value.operationKey)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['operationKey'], message: 'operationKey ownership mismatch' });
  }
});

const workerAuditBatchSchema = z.object({
  scan: scanSchema,
  messages: z.array(messageSchema).max(1000),
  observations: z.array(observationSchema).max(1000),
  operations: z.array(operationSchema).max(200),
}).strict().superRefine((value, context) => {
  const messages = new Map(value.messages.map((message) => [message.logKey, message]));
  const operations = new Map(value.operations.map((operation) => [operation.operationKey, operation]));
  if (messages.size !== value.messages.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages'], message: 'message logKey values must be unique' });
  }
  if (operations.size !== value.operations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['operations'], message: 'operationKey values must be unique' });
  }
  value.messages.forEach((message, index) => {
    if (message.logKey.slice('tglog:raw-v1:'.length) !== message.rawSourceDigest.slice('sha256:'.length)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', index, 'logKey'], message: 'logKey must contain rawSourceDigest' });
    }
  });
  value.operations.forEach((operation, index) => {
    if (operation.scanId !== value.scan.scanId || !messages.has(operation.logKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['operations', index], message: 'operation must reference this batch scan/message' });
    }
    const digest = operation.logKey.slice('tglog:raw-v1:'.length);
    const expectedPrefix = `tgop:v1:${operation.scanId}:${digest}:${operation.operationType}:`;
    if (!operation.operationKey.startsWith(expectedPrefix)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['operations', index, 'operationKey'], message: 'operationKey ownership mismatch' });
    }
  });
  value.observations.forEach((observation, index) => {
    const message = messages.get(observation.logKey);
    const operation = observation.operationKey ? operations.get(observation.operationKey) : undefined;
    if (
      observation.scanId !== value.scan.scanId
      || !message
      || message.sourceChatId !== observation.sourceChatId
      || message.sourceMessageId !== observation.sourceMessageId
      || (observation.operationKey ? !operation || operation.logKey !== observation.logKey : false)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index], message: 'observation must reference this batch scan/message/operation' });
    }
  });
});

export type WorkerAuditBatchDto = z.infer<typeof workerAuditBatchSchema>;

export interface WorkerAuditListQueryDto {
  dateFrom: string;
  dateTo: string;
  page: number;
  pageSize: number;
  sortDirection: 'asc' | 'desc';
  status?: string;
  messageType?: string;
  reasonCode?: string;
  search?: string;
}

export type WorkerAuditExportQueryDto = Omit<WorkerAuditListQueryDto, 'page' | 'pageSize' | 'sortDirection'>;

export function parseWorkerAuditBatch(value: unknown): WorkerAuditBatchDto {
  const parsed = workerAuditBatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'INVALID_CNC_TELEGRAM_WORKER_AUDIT', 'Некорректный пакет журнала Telegram-бота', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

export function parseWorkerAuditListQuery(value: Record<string, unknown>): WorkerAuditListQueryDto {
  return parseWorkerAuditQuery(value, true) as WorkerAuditListQueryDto;
}

export function parseWorkerAuditExportQuery(value: Record<string, unknown>): WorkerAuditExportQueryDto {
  return parseWorkerAuditQuery(value, false) as WorkerAuditExportQueryDto;
}

function parseWorkerAuditQuery(
  value: Record<string, unknown>,
  paginated: boolean,
): WorkerAuditListQueryDto | WorkerAuditExportQueryDto {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFromDate = new Date(today);
  defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 6);
  const filterShape = {
    dateFrom: dateOnly.default(defaultFromDate.toISOString().slice(0, 10)),
    dateTo: dateOnly.default(defaultTo),
    status: z.enum(['observed', 'used', 'ingested', 'skipped', 'failed']).optional(),
    messageType: z.enum(['svg', 'dxf', 'image', 'gcode', 'bot_reply', 'text', 'other']).optional(),
    reasonCode: workerAuditReasonCodeSchema.optional(),
    search: z.string().trim().min(1).max(200).optional(),
  };
  const schema = paginated
    ? z.object({
      ...filterShape,
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().positive().max(100).default(50),
      sortDirection: z.enum(['asc', 'desc']).default('desc'),
    }).strict()
    : z.object(filterShape).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, 'INVALID_AUDIT_QUERY', 'Некорректные фильтры журнала Telegram-бота');
  if (parsed.data.search && /^-?[0-9]+$/.test(parsed.data.search) && !telegramId.safeParse(parsed.data.search).success) {
    throw new ApiError(422, 'INVALID_AUDIT_QUERY', 'Некорректный Telegram ID в поиске');
  }
  const from = new Date(`${parsed.data.dateFrom}T00:00:00Z`);
  const to = new Date(`${parsed.data.dateTo}T00:00:00Z`);
  if (to < from || to.getTime() - from.getTime() > 30 * 86_400_000) {
    throw new ApiError(422, 'INVALID_AUDIT_DATE_RANGE', 'Период должен быть от 1 до 31 дня');
  }
  return parsed.data;
}
