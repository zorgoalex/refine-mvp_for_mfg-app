import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OnecReceiptsService } from '../application/onec-receipts.service';
import type { OnecReceiptCardDto, OnecReceiptCommandResponseDto, OnecReceiptListQuery, OnecReceiptListResponseDto } from '../application/onec-receipts.types';
import { STATE_GROUP_KEYS } from '../domain/onec-receipts';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'not a calendar date');

const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  group: z.enum(STATE_GROUP_KEYS as [string, ...string[]]).optional(),
  kind: z.enum(['receipts', 'refunds']).optional(),
  dateFrom: calendarDate.optional(),
  dateTo: calendarDate.optional(),
  search: z.string().trim().min(1).max(100).optional(),
}).strict();

const token = z.string().min(1).max(200);
const note = z.string().max(500).nullable().optional();
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const matchSchema = z.object({ paymentId: id, expectedStateToken: token, expectedPaymentToken: token, note }).strict();
const unmatchSchema = z.object({ expectedMatchId: id, reason: note }).strict();
const dismissSchema = z.object({ expectedStateToken: token, note: z.string().max(500) }).strict();
const linkSchema = z.object({ expectedStateToken: token, orderId: id.nullable(), note }).strict();
const unlinkSchema = z.object({ expectedStateToken: token }).strict();

function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректные данные команды', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
  }
  return parsed.data;
}

function lineId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'ONEC_RECEIPT_NOT_FOUND', 'Поступление 1С не найдено');
  return id;
}

/**
 * «Платежи → Поступления 1С» (план 2026-10-04-onec-incoming-payments, срез A): поступления и возвраты покупателей
 * из 1С и состояние их сверки с платежами заказов. Только чтение; права и область видимости проверяет сервис.
 */
@ApiTags('Payments')
@ApiBearerAuth('bearerAuth')
@Controller('payments/onec-receipts')
export class OnecReceiptsController {
  constructor(@Inject(OnecReceiptsService) private readonly receipts: OnecReceiptsService) {}

  @ApiOperation({ operationId: 'listOnecReceipts', summary: '1C customer receipts and refunds with their matching state' })
  @Get()
  list(@Req() request: RequestWithCurrentUser, @Query() query: unknown): Promise<OnecReceiptListResponseDto> {
    const parsed = listSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректные параметры списка', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    }
    return this.receipts.list(this.user(request), parsed.data as OnecReceiptListQuery, request.requestId ?? randomUUID());
  }

  @ApiOperation({ operationId: 'autoMatchOnecReceipts', summary: 'Run the auto-match now over the orders in the caller\'s payments.update scope' })
  @Post('auto-match')
  @HttpCode(200)
  autoMatch(@Req() request: RequestWithCurrentUser): Promise<{ matched: number; candidates: number; skipped: boolean }> {
    return this.receipts.autoMatchNow(this.user(request), this.request(request));
  }

  @ApiOperation({ operationId: 'getOnecReceipt', summary: 'One 1C receipt line: order link, candidate payments, refunds, history' })
  @Get(':lineId')
  get(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string): Promise<OnecReceiptCardDto> {
    return this.receipts.getCard(this.user(request), lineId(id), request.requestId ?? randomUUID());
  }

  @ApiOperation({ operationId: 'matchOnecReceipt', summary: 'Match the 1C receipt line with a payment of its ERP order' })
  @Post(':lineId/match')
  @HttpCode(200)
  match(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string, @Body() payload: unknown): Promise<OnecReceiptCommandResponseDto> {
    return this.receipts.match(this.user(request), lineId(id), body(matchSchema, payload), this.request(request));
  }

  @ApiOperation({ operationId: 'unmatchOnecReceipt', summary: 'Remove the active match or «разобрано» of the line' })
  @Post(':lineId/unmatch')
  @HttpCode(200)
  unmatch(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string, @Body() payload: unknown): Promise<OnecReceiptCommandResponseDto> {
    return this.receipts.unmatch(this.user(request), lineId(id), body(unmatchSchema, payload), this.request(request));
  }

  @ApiOperation({ operationId: 'dismissOnecReceipt', summary: 'Mark the line «разобрано» without a payment (comment required)' })
  @Post(':lineId/dismiss')
  @HttpCode(200)
  dismiss(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string, @Body() payload: unknown): Promise<OnecReceiptCommandResponseDto> {
    return this.receipts.dismiss(this.user(request), lineId(id), body(dismissSchema, payload), this.request(request));
  }

  @ApiOperation({ operationId: 'linkOnecReceiptOrder', summary: 'Manual link of the line\'s 1C order to an ERP order (null — not an ERP order)' })
  @Put(':lineId/order-link')
  link(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string, @Body() payload: unknown): Promise<OnecReceiptCommandResponseDto> {
    return this.receipts.link(this.user(request), lineId(id), body(linkSchema, payload), this.request(request));
  }

  @ApiOperation({ operationId: 'unlinkOnecReceiptOrder', summary: 'Remove the manual link of the line\'s 1C order (back to the series rule)' })
  @Post(':lineId/order-unlink')
  @HttpCode(200)
  unlink(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string, @Body() payload: unknown): Promise<OnecReceiptCommandResponseDto> {
    return this.receipts.unlink(this.user(request), lineId(id), body(unlinkSchema, payload), this.request(request));
  }

  private request(request: RequestWithCurrentUser & { headers?: Record<string, string | string[] | undefined> }) {
    const raw = request.headers?.['x-correlation-id'];
    const correlation = Array.isArray(raw) ? raw[0] : raw;
    return { requestId: request.requestId ?? randomUUID(), correlationId: correlation ? correlation.slice(0, 100) : null };
  }

  private user(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
