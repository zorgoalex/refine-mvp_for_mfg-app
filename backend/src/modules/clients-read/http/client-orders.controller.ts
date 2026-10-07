import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ClientOrdersService } from '../application/client-orders.service';
import { CLIENT_ORDERS_PAGE_SIZE_MAX, type ClientOrdersResponseDto } from '../application/client-orders.types';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(CLIENT_ORDERS_PAGE_SIZE_MAX).default(20),
}).strict();

/** Client card, tab «Документы ERP»: the orders of one client the user may see, with totals. Read-only. */
@ApiTags('Client Phones')
@ApiBearerAuth('bearerAuth')
@Controller('clients')
export class ClientOrdersController {
  constructor(@Inject(ClientOrdersService) private readonly orders: ClientOrdersService) {}

  @ApiOperation({ operationId: 'listClientOrders', summary: 'Orders of one client within the order visibility of the user, with totals over all pages' })
  @Get(':clientId/orders')
  list(@Req() request: RequestWithCurrentUser, @Param('clientId') clientId: string, @Query() query: unknown): Promise<ClientOrdersResponseDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const id = /^[1-9]\d{0,14}$/.test(clientId) ? Number(clientId) : NaN;
    const parsed = querySchema.safeParse(query ?? {});
    if (!Number.isSafeInteger(id) || !parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный запрос заказов клиента');
    return this.orders.list(request.user, id, parsed.data.page, parsed.data.pageSize, request.requestId ?? randomUUID());
  }
}
