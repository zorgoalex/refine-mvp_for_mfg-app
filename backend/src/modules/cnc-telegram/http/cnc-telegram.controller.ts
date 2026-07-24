import { Body, Controller, Get, Headers, Inject, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramService } from '../application/cnc-telegram.service';
import type {
  CncTelegramIngestResponseDto,
  CncTelegramStructuredIngestDto,
  CncTelegramTodayResponseDto,
} from '../dto/cnc-telegram.dto';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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
  source: z.enum(['ocr', 'gcode', 'manual']),
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
    updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict(),
  workday: z.string().regex(DATE_ONLY).refine(isValidDateOnly).optional(),
  machine: z.string().trim().min(1).max(64).nullable().optional(),
  programName: z.string().trim().min(1).max(200).nullable().optional(),
  materialName: z.string().trim().min(1).max(120).nullable().optional(),
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
  ) {}

  @ApiOperation({
    operationId: 'listCncTelegramToday',
    summary: 'List current-day structured CNC Telegram parsing results',
  })
  @ApiQuery({ name: 'date', required: false, type: String })
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
    return this.cncTelegram.listToday({
      currentUser,
      workday: parseDateQuery(query.date),
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

export function parseDateQuery(value: unknown): string | null {
  if (value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !DATE_ONLY.test(value) || !isValidDateOnly(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'date must use YYYY-MM-DD format', {
      field: 'date',
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
