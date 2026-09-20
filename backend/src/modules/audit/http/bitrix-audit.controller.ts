import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { BitrixAuditService } from '../application/bitrix-audit.service';

const id = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/)
  .optional();
const queueSchema = z
  .object({
    direction: z.enum(['forward', 'reverse']),
    queueType: z.enum(['entity', 'order_stage']).optional(),
    status: z
      .enum(['pending', 'processing', 'processed', 'failed', 'dead', 'blocked', 'waiting_mapping', 'cancelled'])
      .optional(),
    orderId: z.coerce.number().int().positive().safe().optional(),
    entityType: z.enum(['order', 'client', 'payment']).optional(),
    entityId: id,
    bitrixObject: z.enum(['deal', 'contact', 'company', 'payment']).optional(),
    bitrixId: id,
    page: z.coerce.number().int().positive().max(1000000).default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(50),
  })
  .refine(
    (q) => !q.bitrixId || q.bitrixObject,
    'Bitrix object type is required'
  )
  .refine((q) => !q.entityId || q.entityType, 'ERP entity type is required');

export function parseBitrixQueueQuery(query: unknown) {
  const result = queueSchema.safeParse(query);
  if (!result.success)
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid Bitrix queue filters');
  return result.data;
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit/bitrix24')
export class BitrixAuditController {
  constructor(
    @Inject(BitrixAuditService) private readonly service: BitrixAuditService
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Read Bitrix queue counters and runtime flags (audit.view)' })
  status(@Req() request: RequestWithCurrentUser) {
    return this.service.status(request.user);
  }

  @Get('queue')
  @ApiOperation({ summary: 'Search the current forward or reverse Bitrix queue (audit.view)' })
  queue(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, unknown>
  ) {
    return this.service.queue(request.user, parseBitrixQueueQuery(query));
  }

  @Get('event-options')
  @ApiOperation({ summary: 'Search Bitrix audit event names without the recent-history cap (audit.view)' })
  events(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, unknown>
  ) {
    const result = z
      .object({ search: z.string().trim().max(128).optional() })
      .safeParse(query);
    if (!result.success)
      throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid event search');
    return this.service.eventOptions(request.user, result.data.search);
  }
}
