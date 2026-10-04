import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OnecReceiptsService } from '../application/onec-receipts.service';
import type { OnecReceiptCardDto, OnecReceiptListQuery, OnecReceiptListResponseDto } from '../application/onec-receipts.types';
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

  @ApiOperation({ operationId: 'getOnecReceipt', summary: 'One 1C receipt line: order link, candidate payments, refunds, history' })
  @Get(':lineId')
  get(@Req() request: RequestWithCurrentUser, @Param('lineId') id: string): Promise<OnecReceiptCardDto> {
    return this.receipts.getCard(this.user(request), lineId(id), request.requestId ?? randomUUID());
  }

  private user(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
