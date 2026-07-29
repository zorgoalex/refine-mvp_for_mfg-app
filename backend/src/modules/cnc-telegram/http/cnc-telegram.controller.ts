import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramService } from '../application/cnc-telegram.service';
import type {
  CncTelegramIngestResponseDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const STORAGE_KEY_RE = /^[A-Za-z0-9._-]{1,220}$/;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const toolSchema = z.object({
  toolNumber: z.number().int().positive().max(999),
  spindleRpm: z.number().int().positive().max(100000).nullable().optional(),
}).strict();

const dowelingLinkSchema = z.object({
  orderName: z.string().trim().min(1).max(64),
  dowelingNumber: z.string().trim().min(1).max(64),
}).strict();

const itemSchema = z.object({
  sourceItemKey: z.string().trim().min(1).max(120),
  orderName: z.string().trim().min(1).max(64),
  detailNumber: z.number().int().positive().nullable().optional(),
  widthMm: z.number().positive().max(10000).nullable().optional(),
  heightMm: z.number().positive().max(10000).nullable().optional(),
  quantity: z.number().int().positive().max(1000),
  source: z.enum(['vector', 'ocr', 'gcode', 'manual']),
  confidence: z.number().min(0).max(1),
  matchOrderId: z.number().int().positive().nullable().optional(),
  matchDetailId: z.number().int().positive().nullable().optional(),
  matchStatus: z.enum(['unmatched', 'matched', 'conflict', 'needs_review']).optional(),
  reviewNote: z.string().trim().max(500).nullable().optional(),
}).strict().superRefine((item, context) => {
  const status = item.matchStatus ?? 'unmatched';
  const hasOrder = item.matchOrderId !== undefined && item.matchOrderId !== null;
  const hasDetail = item.matchDetailId !== undefined && item.matchDetailId !== null;

  if (status === 'matched' && (!hasOrder || !hasDetail)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'matched rows require matchOrderId and matchDetailId',
      path: ['matchStatus'],
    });
  }
  if (status === 'unmatched' && (hasOrder || hasDetail)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'unmatched rows must not carry match ids',
      path: ['matchStatus'],
    });
  }
  if (hasDetail && !hasOrder) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'matchDetailId requires matchOrderId',
      path: ['matchDetailId'],
    });
  }
});

const ingestSchema = z.object({
  externalPacketKey: z.string().trim().min(1).max(200),
  source: z.object({
    chatId: z.string().trim().min(1).max(120),
    messageId: z.number().int().positive().nullable().optional(),
    threadId: z.number().int().positive().nullable().optional(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }).nullable().optional(),
    updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict(),
  workday: z.string().regex(DATE_ONLY).refine(isValidDateOnly).optional(),
  machine: z.string().trim().min(1).max(64).nullable().optional(),
  programName: z.string().trim().min(1).max(200).nullable().optional(),
  materialName: z.string().trim().min(1).max(120).nullable().optional(),
  sheetImage: z.object({
    storageKey: z.string().trim().regex(STORAGE_KEY_RE).max(220),
    contentType: z.string().trim().min(1).max(120).nullable().optional(),
    sizeBytes: z.number().int().positive().max(50 * 1024 * 1024).nullable().optional(),
  }).strict().nullable().optional(),
  parseStatus: z.enum(['received', 'parsed', 'needs_review']).optional(),
  completionStatus: z.enum(['pending', 'completed']).optional(),
  thumbsUp: z.boolean().optional(),
  completedAt: z.string().datetime({ offset: true }).nullable().optional(),
  rework: z.boolean().optional(),
  comments: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  tools: z.array(toolSchema).max(50).optional(),
  dowelingLinks: z.array(dowelingLinkSchema).max(50).optional(),
  analysisWarnings: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  ocrEngine: z.string().trim().min(1).max(120).nullable().optional(),
  parserVersion: z.string().trim().min(1).max(120).nullable().optional(),
  items: z.array(itemSchema).min(1).max(2000),
}).strict();

@ApiTags('CncTelegram')
@ApiBearerAuth()
@Controller('cnc-telegram')
export class CncTelegramController {
  constructor(
    @Inject(CncTelegramService)
    private readonly cncTelegram: CncTelegramService,
    @Inject(CncTelegramRuntimeConfigService)
    private readonly runtimeConfig: CncTelegramRuntimeConfigService,
    @Inject(ConfigService)
    private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  @ApiOperation({
    operationId: 'listCncTelegramToday',
    summary: 'List current-day structured CNC Telegram parsing results',
  })
  @ApiQuery({ name: 'date', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String })
  @ApiQuery({ name: 'dateTo', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Current-day CNC Telegram packets' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid date query' })
  @ApiResponse({ status: 503, description: 'CNC Telegram API is disabled' })
  @Get('today')
  listToday(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, unknown>,
  ): Promise<CncTelegramTodayResponseDto> {
    this.assertEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsedQuery = parseTodayQuery(query);
    return this.cncTelegram.listToday({
      currentUser,
      workday: parsedQuery.workday,
      workdayFrom: parsedQuery.workdayFrom,
      workdayTo: parsedQuery.workdayTo,
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'ingestCncTelegramPacket',
    summary: 'Ingest structured CNC Telegram parse results without raw media',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 201, description: 'Structured packet accepted' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency or source-version conflict' })
  @ApiResponse({ status: 422, description: 'Invalid structured packet payload' })
  @ApiResponse({ status: 503, description: 'CNC Telegram API is disabled' })
  @Post('ingest')
  ingest(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<CncTelegramIngestResponseDto> {
    this.assertEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.cncTelegram.ingest({
      currentUser,
      dto: parseStructuredIngest(body, parseIdempotencyKey(idempotencyKey)),
      requestId: request.requestId,
    });
  }

  @ApiOperation({
    operationId: 'getCncTelegramSheetImage',
    summary: 'Get stored Telegram cutting sheet image',
  })
  @ApiResponse({ status: 200, description: 'Stored cutting sheet image' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Image not found' })
  @ApiResponse({ status: 422, description: 'Invalid storage key' })
  @ApiResponse({ status: 503, description: 'CNC Telegram API is disabled' })
  @Get('media/:storageKey')
  async getMedia(
    @Req() request: RequestWithCurrentUser,
    @Param('storageKey') storageKey: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertEnabled();
    this.requireCurrentUser(request);
    const safeKey = parseStorageKey(storageKey);
    const mediaDir = this.config.get('CNC_TELEGRAM_MEDIA_DIR', { infer: true });
    const absoluteDir = resolve(mediaDir);
    const absolutePath = resolve(absoluteDir, safeKey);
    if (!absolutePath.startsWith(`${absoluteDir}/`)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid CNC Telegram media key', {
        field: 'storageKey',
      });
    }
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      throw new ApiError(404, 'NOT_FOUND', 'CNC Telegram media file not found', {
        storageKey: safeKey,
      });
    }
    if (!fileStat.isFile()) {
      throw new ApiError(404, 'NOT_FOUND', 'CNC Telegram media file not found', {
        storageKey: safeKey,
      });
    }
    response.setHeader('Content-Type', contentTypeForStorageKey(safeKey));
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Content-Length', String(fileStat.size));
    response.setHeader('Content-Disposition', `inline; filename="${safeKey}"`);
    createReadStream(absolutePath).pipe(response);
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cncTelegramEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', {
        feature: 'cnc_telegram',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return request.user;
  }
}

export function parseStructuredIngest(
  body: unknown,
  idempotencyKey: string,
): CncTelegramStructuredIngestDto {
  const parsed = ingestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid CNC Telegram packet payload', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return { ...parsed.data, idempotencyKey };
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const key = raw?.trim();
  if (!key || key.length < 8 || key.length > 160) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key header is required', {
      field: 'Idempotency-Key',
    });
  }
  return key;
}

export function parseTodayQuery(query: Record<string, unknown>): {
  workday: string | null;
  workdayFrom: string | null;
  workdayTo: string | null;
} {
  const workday = parseDateQuery(query.date, 'date');
  const workdayFrom = parseDateQuery(query.dateFrom, 'dateFrom');
  const workdayTo = parseDateQuery(query.dateTo, 'dateTo');
  if (workday && (workdayFrom || workdayTo)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'date cannot be combined with dateFrom/dateTo', {
      field: 'date',
    });
  }
  if ((workdayFrom && !workdayTo) || (!workdayFrom && workdayTo)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'dateFrom and dateTo must be provided together', {
      field: workdayFrom ? 'dateTo' : 'dateFrom',
    });
  }
  if (workdayFrom && workdayTo && workdayFrom > workdayTo) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'dateFrom must be before or equal dateTo', {
      field: 'dateFrom',
    });
  }
  return { workday, workdayFrom, workdayTo };
}

export function parseDateQuery(value: unknown, field = 'date'): string | null {
  if (value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !DATE_ONLY.test(value) || !isValidDateOnly(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must use YYYY-MM-DD format`, {
      field,
    });
  }
  return value;
}

function isValidDateOnly(value: string): boolean {
  if (value.startsWith('0000-')) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
}

function parseStorageKey(value: string): string {
  const key = value.trim();
  if (!STORAGE_KEY_RE.test(key) || !IMAGE_EXTENSIONS.has(extname(key).toLowerCase())) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid CNC Telegram media key', {
      field: 'storageKey',
    });
  }
  return key;
}

function contentTypeForStorageKey(storageKey: string): string {
  switch (extname(storageKey).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}
