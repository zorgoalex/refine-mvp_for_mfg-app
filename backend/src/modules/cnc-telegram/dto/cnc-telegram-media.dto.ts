import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

export type CncTelegramMediaRestoreStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type CncTelegramManualSvgFileKind = 'svg' | 'gcode' | 'screenshot';
export type CncTelegramManualSvgTelegramSendStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'unknown';

export interface CncTelegramOrderScreenshotDto {
  kind: 'telegram' | 'svg_cut';
  packetId: string;
  sourceMessageId: number | null;
  sourceCreatedAt: string;
  programName: string | null;
  materialName: string;
  matchedDetailCount: number;
  itemQuantityTotal: number;
  previewUrl: string | null;
  imageUrl: string | null;
  cutJobId?: number | null;
  cutJobDisplayNumber?: string | null;
  cutResultNo?: number | null;
  cutGroupId?: number | null;
  sheetIndex?: number | null;
  sheetNumber?: number | null;
  variant?: 'auto' | 'manual' | null;
  originalAvailable: boolean;
  availableUntil: string;
  restore: {
    requestId: string;
    status: CncTelegramMediaRestoreStatus;
    requestedAt: string;
    error: string | null;
  } | null;
}

export interface CncTelegramOrderScreenshotsResponseDto {
  orderId: number;
  generatedAt: string;
  originalRetentionDays: 30;
  screenshots: CncTelegramOrderScreenshotDto[];
  manualFiles: CncTelegramManualSvgOrderFileDto[];
}

export interface CncTelegramManualSvgOrderFileDto {
  fileId: string;
  packetId: string;
  kind: CncTelegramManualSvgFileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  generated: boolean;
  createdAt: string;
  expiresAt: string;
  downloadUrl: string;
  cutJobId: number | null;
  cutJobDisplayNumber: string | null;
  cutResultId: number | null;
  cutResultNo: number | null;
  telegramSendStatus: CncTelegramManualSvgTelegramSendStatus | null;
}

export interface CncTelegramMediaRestoreResponseDto {
  requestId: string;
  packetId: string;
  status: CncTelegramMediaRestoreStatus;
  requestedAt: string;
  availableUntil: string | null;
}

export interface CncTelegramMediaRestoreTaskDto {
  requestId: string;
  packetId: string;
  sourceChatId: string;
  sourceMessageId: number;
  storageKey: string;
  attempt: number;
}

export interface CncTelegramMediaRestoreClaimResponseDto {
  capability: 'cnc_telegram_media_restore_v1';
  tasks: CncTelegramMediaRestoreTaskDto[];
}

export interface CncTelegramManualSvgTelegramFileTaskDto {
  fileId: string;
  kind: CncTelegramManualSvgFileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  base64Content: string;
}

export interface CncTelegramManualSvgTelegramSendTaskDto {
  requestId: string;
  packetId: string;
  messageText: string;
  attempt: number;
  files: CncTelegramManualSvgTelegramFileTaskDto[];
}

export interface CncTelegramManualSvgTelegramSendClaimResponseDto {
  capability: 'cnc_manual_svg_telegram_send_v1';
  tasks: CncTelegramManualSvgTelegramSendTaskDto[];
}

export interface CncTelegramManualSvgTelegramSendResponseDto {
  requestId: string;
  packetId: string;
  status: CncTelegramManualSvgTelegramSendStatus;
  requestedAt: string;
  finishedAt: string | null;
  sentChatId: string | null;
  sentMessageIds: string[];
  error: string | null;
}

export interface CncTelegramManualSvgTelegramSendCompleteDto {
  sentChatId: string;
  sentMessageIds: string[];
}

export interface CncTelegramMediaRestoreCompleteDto {
  storageKey: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
}

const completeSchema = z.object({
  storageKey: z.string().trim().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,214}\.(?:jpe?g|png|webp)$/i),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive().max(12 * 1024 * 1024),
}).strict().superRefine((value, context) => {
  const extension = value.storageKey.split('.').pop()?.toLowerCase();
  const expectedContentType = extension === 'png'
    ? 'image/png'
    : extension === 'webp'
      ? 'image/webp'
      : 'image/jpeg';
  if (value.contentType !== expectedContentType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentType'],
      message: 'Content type does not match storage key extension',
    });
  }
});

const failSchema = z.object({
  error: z.string().trim().min(1).max(500),
}).strict();

const telegramSendCompleteSchema = z.object({
  sentChatId: z.string().trim().min(1).max(120),
  sentMessageIds: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
}).strict();

const uuidSchema = z.string().trim().uuid();

export function parseCncTelegramMediaRestoreComplete(value: unknown): CncTelegramMediaRestoreCompleteDto {
  return parse(completeSchema, value, 'body') as CncTelegramMediaRestoreCompleteDto;
}

export function parseCncTelegramMediaRestoreFailure(value: unknown): string {
  return (parse(failSchema, value, 'body') as { error: string }).error;
}

export function parseCncTelegramManualSvgTelegramSendComplete(
  value: unknown,
): CncTelegramManualSvgTelegramSendCompleteDto {
  return parse(telegramSendCompleteSchema, value, 'body') as CncTelegramManualSvgTelegramSendCompleteDto;
}

export function parseCncTelegramMediaRestoreRequestId(value: string): string {
  return parse(uuidSchema, value, 'requestId') as string;
}

export function parseCncTelegramPacketId(value: string): string {
  return parse(uuidSchema, value, 'packetId') as string;
}

export function parseCncTelegramManualSvgFileId(value: string): string {
  return parse(uuidSchema, value, 'fileId') as string;
}

function parse(schema: z.ZodType, value: unknown, field: string): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid CNC Telegram media request', {
    field,
    errors: result.error.issues.map((issue) => ({
      field: [field, ...issue.path].join('.'),
      message: issue.message,
    })),
  });
}
