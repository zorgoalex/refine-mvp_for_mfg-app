import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ClientPaymentsService } from '../application/client-payments.service';
import { CLIENT_PAYMENTS_PAGE_SIZE_MAX, type ClientPaymentsResponseDto } from '../application/client-payments.types';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(CLIENT_PAYMENTS_PAGE_SIZE_MAX).default(20),
}).strict();

/** Client card, tab «Платежи»: the payments of the orders of one client the user may see, with their sum. Read-only. */
@ApiTags('Client Phones')
@ApiBearerAuth('bearerAuth')
@Controller('clients')
export class ClientPaymentsController {
  constructor(@Inject(ClientPaymentsService) private readonly payments: ClientPaymentsService) {}

  @ApiOperation({ operationId: 'listClientPayments', summary: 'Payments of the orders of one client within the order and payment visibility of the user, with their sum' })
  @Get(':clientId/payments')
  list(@Req() request: RequestWithCurrentUser, @Param('clientId') clientId: string, @Query() query: unknown): Promise<ClientPaymentsResponseDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const id = /^[1-9]\d{0,14}$/.test(clientId) ? Number(clientId) : NaN;
    const parsed = querySchema.safeParse(query ?? {});
    if (!Number.isSafeInteger(id) || !parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный запрос платежей клиента');
    return this.payments.list(request.user, id, parsed.data.page, parsed.data.pageSize, request.requestId ?? randomUUID());
  }
}
