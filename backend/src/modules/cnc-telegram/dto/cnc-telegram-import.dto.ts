import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

const uuid = z.string().uuid();
const sha256 = z.string().trim().regex(/^[a-f0-9]{64}$/i).transform((v) => v.toLowerCase());
const sourceFingerprint = z.string().trim().regex(/^[a-f0-9]{64}$/i).transform((v) => v.toLowerCase());
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const leaseToken = z.string().trim().min(32).max(240);
const MAX_POSTGRES_BIGINT = '9223372036854775807';
/**
 * Telegram ids cross a JavaScript HTTP boundary.  Keep the canonical form as
 * a decimal string, while accepting legacy safe integers during the rollout.
 * Unsafe JSON numbers are rejected because their original digits are already
 * unrecoverable by the time Zod sees them.
 */
const telegramId = z.union([
  z.string().trim().regex(/^[1-9]\d*$/).max(19),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
]).transform((value) => String(value)).refine(
  (value) => value.length < MAX_POSTGRES_BIGINT.length || (value.length === MAX_POSTGRES_BIGINT.length && value <= MAX_POSTGRES_BIGINT),
  { message: 'Telegram id must fit PostgreSQL BIGINT' },
);
const workerItemLease = z.object({
  itemLeaseToken: leaseToken,
  itemLeaseGeneration: z.number().int().positive(),
  itemLeaseOwner: uuid,
}).strict();

export interface CncTelegramImportScanDto {
  scanId: string;
  sourceChatId: string;
  dateFrom: string;
  dateTo: string;
  businessTimezone: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'expired';
  requestedAt: string;
  finishedAt: string | null;
  progress: {
    daysTotal: number;
    daysProcessed: number;
    messagesTotal: number;
    messagesProcessed: number;
    candidatesTotal: number;
    warningsTotal: number;
    truncated: boolean;
  };
  error: string | null;
  itemLeaseToken?: string;
  itemLeaseGeneration?: number;
  itemLeaseOwner?: string;
  daysProcessed?: number;
  messagesScanned?: number;
  candidatesFound?: number;
  warningsCount?: number;
  truncated?: boolean;
}

export interface CncTelegramImportCandidateDto {
  candidateId: string;
  scanId: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceThreadId?: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt?: string | null;
  workday: string;
  svgMessageId?: string | null;
  gcodeMessageId: string | null;
  screenshotMessageId: string | null;
  svgFileName: string;
  gcodeFileName: string | null;
  screenshotFileName: string | null;
  svgContentSha256: string;
  gcodeContentSha256: string | null;
  screenshotContentSha256: string | null;
  sourceSetFingerprint: string;
  previewUrl?: string | null;
  sheetWidthMm?: number | null;
  sheetHeightMm?: number | null;
  sheetCount?: number | null;
  positionCount?: number | null;
  orderLabels?: string[];
  parserWarnings: string[];
  sourceStatus: 'new' | 'similar' | 'previously_imported' | 'incomplete' | 'source_changed' | 'expired';
  eligibility: 'eligible' | 'ineligible';
  eligibilityReason?: string | null;
  /** Worker-only integrity fields; never used as packet/job/result authority. */
  parserVersion?: string;
  layoutFingerprint?: string | null;
  parsedSnapshot?: Record<string, unknown>;
  cutLayout?: Record<string, unknown> | null;
  matches: CncTelegramImportMatchDto[];
  duplicateMatchVersion?: number;
}

export type CncTelegramImportMessageType = 'svg' | 'dxf' | 'image' | 'gcode' | 'text' | 'other';
export type CncTelegramImportMessageCandidateRole = 'svg' | 'gcode' | 'screenshot' | 'comment';

/**
 * A raw message observed by one explicit import scan. Telegram identifiers are
 * strings at the HTTP boundary so that large channel/message ids cannot lose
 * precision in JavaScript clients.
 */
export interface CncTelegramImportMessageDto {
  scanMessageId: string;
  scanId: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceThreadId: string | null;
  replyToMessageId: string | null;
  senderUserId: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string | null;
  workday: string;
  messageType: CncTelegramImportMessageType;
  filename: string | null;
  mimeType: string | null;
  messageText: string | null;
  outgoing: boolean;
  candidateId: string | null;
  candidateRole: CncTelegramImportMessageCandidateRole | null;
  readOrdinal: number;
}

export interface CncTelegramImportMatchDto {
  kind: 'same_telegram_source' | 'sent_by_erp_manual_upload' | 'exact_svg_content' | 'same_layout';
  packetId: string | null;
  cutJobId: number | null;
  cutResultId: number | null;
}

export interface CncTelegramImportRequestDto {
  importRequestId: string;
  scanId: string;
  requestedBy: string;
  status: 'draft' | 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
  confirmationId: string;
  repeatOfImportRequestId: string | null;
  totalCount: number;
  importedCount: number;
  failedCount: number;
  items: CncTelegramImportItemDto[];
  error: string | null;
  selectionHash?: string;
  duplicateMatchVersion?: number;
  duplicateCount?: number;
  refreshedMatches?: CncTelegramImportMatchDto[];
  candidates?: CncTelegramImportCandidateDto[];
  refreshedCandidates?: CncTelegramImportCandidateDto[];
}

export interface CncTelegramImportItemDto {
  importItemId: string;
  candidateId: string;
  status: 'pending' | 'processing' | 'confirmation_required' | 'imported' | 'failed' | 'unknown';
  duplicateAcknowledged: boolean;
  duplicateMatchVersion: number;
  matches: CncTelegramImportMatchDto[];
  duplicateSnapshot?: CncTelegramImportMatchDto[];
  packetId: string | null;
  cutJobId: number | null;
  cutResultId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  itemLeaseToken?: string;
  itemLeaseGeneration?: number;
  itemLeaseOwner?: string;
  candidate?: CncTelegramImportCandidateDto;
}

export interface CncTelegramImportCandidateBatchDto {
  itemLeaseToken: string;
  itemLeaseGeneration: number;
  itemLeaseOwner: string;
  candidates: Array<{
    sourceChatId: string;
    sourceMessageId: string;
    sourceThreadId?: string | null;
    sourceCreatedAt?: string | null;
    sourceUpdatedAt?: string | null;
    workday: string;
    svgMessageId: string;
    gcodeMessageId?: string | null;
    screenshotMessageId?: string | null;
    svgFileName: string;
    gcodeFileName?: string | null;
    screenshotFileName?: string | null;
    svgContentSha256: string;
    gcodeContentSha256?: string | null;
    screenshotContentSha256?: string | null;
    sourceSetFingerprint: string;
    parserVersion: string;
    layoutFingerprint?: string | null;
    parsedSnapshot: Record<string, unknown>;
    cutLayout?: Record<string, unknown> | null;
    warnings?: string[];
    eligibilityStatus: 'valid' | 'invalid' | 'incomplete';
  }>;
  messages: Array<{
    sourceChatId: string;
    sourceMessageId: string;
    sourceThreadId?: string | null;
    replyToMessageId?: string | null;
    senderUserId?: string | null;
    sourceCreatedAt: string;
    sourceUpdatedAt?: string | null;
    workday: string;
    messageType: CncTelegramImportMessageType;
    filename?: string | null;
    mimeType?: string | null;
    messageText?: string | null;
    outgoing?: boolean;
    candidateSourceMessageId?: string | null;
    candidateRole?: CncTelegramImportMessageCandidateRole | null;
    readOrdinal: number;
  }>;
  daysScanned?: number;
  messagesScanned?: number;
  truncated?: boolean;
}

export interface CncTelegramImportScanFailureDto extends z.infer<typeof workerItemLease> { errorCode: string; errorMessage: string; }
export interface CncTelegramImportScanCompleteDto extends z.infer<typeof workerItemLease> { daysScanned?: number; messagesScanned?: number; truncated?: boolean; }
export interface CncTelegramImportCompleteDto extends z.infer<typeof workerItemLease> {
  sourceSetFingerprint: string;
  source: {
    sourceChatId: string;
    sourceMessageId: string;
    svgMessageId?: string | null;
    gcodeMessageId?: string | null;
    screenshotMessageId?: string | null;
    svgFileName: string;
    gcodeFileName?: string | null;
    screenshotFileName?: string | null;
    svgContentSha256: string;
    gcodeContentSha256?: string | null;
    screenshotContentSha256?: string | null;
  };
  sourceFiles: Array<{
    kind: 'svg' | 'gcode' | 'screenshot';
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    base64Content: string;
  }>;
}
export interface CncTelegramImportFailDto extends z.infer<typeof workerItemLease> { errorCode: string; errorMessage: string; }

const createScanSchema = z.object({ dateFrom: dateOnly, dateTo: dateOnly }).strict();
const prepareSchema = z.object({
  candidateIds: z.array(uuid).min(1).max(500),
  repeatOfImportRequestId: uuid.nullable().optional(),
}).strict();
const confirmSchema = z.object({
  confirmationId: uuid,
  duplicateAcknowledgements: z.array(z.object({ candidateId: uuid, duplicateAcknowledged: z.boolean() }).strict()).min(1).max(500),
}).strict();
const candidateSchema = z.object({
  sourceChatId: z.string().trim().min(1).max(120), sourceMessageId: telegramId,
  sourceThreadId: telegramId.nullable().optional(), sourceCreatedAt: z.string().datetime({ offset: true }).nullable().optional(), sourceUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  workday: dateOnly,
  svgMessageId: telegramId, gcodeMessageId: telegramId.nullable().optional(), screenshotMessageId: telegramId.nullable().optional(),
  svgFileName: z.string().trim().min(1).max(240), gcodeFileName: z.string().trim().max(240).nullable().optional(), screenshotFileName: z.string().trim().max(240).nullable().optional(),
  svgContentSha256: sha256, gcodeContentSha256: sha256.nullable().optional(), screenshotContentSha256: sha256.nullable().optional(),
  sourceSetFingerprint: sourceFingerprint, parserVersion: z.string().trim().min(1).max(120), layoutFingerprint: sha256.nullable().optional(),
  parsedSnapshot: z.record(z.string(), z.unknown()).default({}), cutLayout: z.record(z.string(), z.unknown()).nullable().optional(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(100).default([]), eligibilityStatus: z.enum(['valid','invalid','incomplete']),
}).strict();
const importMessageSchema = z.object({
  sourceChatId: z.string().trim().min(1).max(120),
  sourceMessageId: telegramId,
  sourceThreadId: telegramId.nullable().optional(),
  replyToMessageId: telegramId.nullable().optional(),
  senderUserId: telegramId.nullable().optional(),
  sourceCreatedAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  workday: dateOnly,
  messageType: z.enum(['svg', 'dxf', 'image', 'gcode', 'text', 'other']),
  filename: z.string().trim().max(255).nullable().optional(),
  mimeType: z.string().trim().max(120).nullable().optional(),
  messageText: z.string().max(2000).nullable().optional(),
  outgoing: z.boolean().optional().default(false),
  candidateSourceMessageId: telegramId.nullable().optional(),
  candidateRole: z.enum(['svg', 'gcode', 'screenshot', 'comment']).nullable().optional(),
  readOrdinal: z.number().int().positive().max(5000),
}).strict().superRefine((value, context) => {
  const hasCandidate = value.candidateSourceMessageId != null;
  const hasRole = value.candidateRole != null;
  if (hasCandidate !== hasRole) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['candidateRole'], message: 'candidateSourceMessageId and candidateRole must be provided together' });
  }
});
const candidateBatchSchema = workerItemLease.extend({
  candidates: z.array(candidateSchema).max(500),
  messages: z.array(importMessageSchema).max(5000).default([]),
  daysScanned: z.number().int().min(0).max(31).optional(),
  messagesScanned: z.number().int().min(0).max(5000).optional(),
  truncated: z.boolean().optional(),
}).strict();
const failureSchema = workerItemLease.extend({ errorCode: z.string().trim().min(1).max(80), errorMessage: z.string().trim().min(1).max(500) }).strict();
const scanCompleteSchema = workerItemLease.extend({ daysScanned: z.number().int().min(0).max(31).optional(), messagesScanned: z.number().int().min(0).max(5000).optional(), truncated: z.boolean().optional() }).strict();
const completeSchema = workerItemLease.extend({
  sourceSetFingerprint: sourceFingerprint,
  source: z.object({
    sourceChatId: z.string().trim().min(1).max(120), sourceMessageId: telegramId,
    svgMessageId: telegramId.nullable().optional(), gcodeMessageId: telegramId.nullable().optional(), screenshotMessageId: telegramId.nullable().optional(),
    svgFileName: z.string().trim().min(1).max(240), gcodeFileName: z.string().trim().max(240).nullable().optional(), screenshotFileName: z.string().trim().max(240).nullable().optional(),
    svgContentSha256: sha256, gcodeContentSha256: sha256.nullable().optional(), screenshotContentSha256: sha256.nullable().optional(),
  }).strict(),
  sourceFiles: z.array(z.object({
    kind: z.enum(['svg', 'gcode', 'screenshot']), fileName: z.string().trim().min(1).max(240),
    contentType: z.string().trim().min(1).max(120), sizeBytes: z.number().int().positive().max(15_728_640),
    sha256, base64Content: z.string().min(1).max(21_000_000),
  }).strict()).min(1).max(3),
}).strict().superRefine((value, context) => {
  if (value.sourceFiles.reduce((total, file) => total + file.sizeBytes, 0) > 37_748_736) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceFiles'], message: 'Source files exceed the 36 MiB total limit' });
  }
});
const importFailSchema = workerItemLease.extend({ errorCode: z.string().trim().min(1).max(80), errorMessage: z.string().trim().min(1).max(500) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_IMPORT', `Invalid ${name}`, { issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return result.data;
}
export const parseImportScanCreate = (v: unknown) => parse(createScanSchema, v, 'scan payload');
export const parseImportPrepare = (v: unknown) => parse(prepareSchema, v, 'prepare payload');
export const parseImportConfirm = (v: unknown) => parse(confirmSchema, v, 'confirm payload');
export const parseImportCandidateBatch = (v: unknown): CncTelegramImportCandidateBatchDto => parse(candidateBatchSchema, v, 'candidate batch');
export const parseImportScanFailure = (v: unknown): CncTelegramImportScanFailureDto => parse(failureSchema, v, 'scan failure');
export const parseImportScanComplete = (v: unknown): CncTelegramImportScanCompleteDto => parse(scanCompleteSchema, v, 'scan completion');
export const parseImportComplete = (v: unknown): CncTelegramImportCompleteDto => parse(completeSchema, v, 'import completion');
export const parseImportFailure = (v: unknown): CncTelegramImportFailDto => parse(importFailSchema, v, 'import failure');

export function parseImportListQuery(value: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Number(value.page ?? 1); const pageSize = Number(value.pageSize ?? 50);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError(422, 'INVALID_CNC_TELEGRAM_IMPORT', 'Invalid pagination');
  return { page, pageSize };
}
