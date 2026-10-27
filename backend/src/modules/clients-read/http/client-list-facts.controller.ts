import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ClientListFactsService } from '../application/client-list-facts.service';
import { CLIENT_LIST_FACTS_MAX_IDS, type ClientListFactsResponseDto } from '../application/client-list-facts.types';

const querySchema = z.object({
  ids: z.string().regex(/^\d{1,15}(,\d{1,15})*$/).transform((value) => [...new Set(value.split(',').map(Number))])
    .refine((ids) => ids.length <= CLIENT_LIST_FACTS_MAX_IDS && ids.every((id) => Number.isSafeInteger(id) && id > 0), 'bad ids'),
}).strict();

/** «Клиенты»: phone, number of orders and last order for the clients of one list page. Read-only. */
@ApiTags('Client Phones')
@ApiBearerAuth('bearerAuth')
@Controller('clients')
export class ClientListFactsController {
  constructor(@Inject(ClientListFactsService) private readonly facts: ClientListFactsService) {}

  @ApiOperation({ operationId: 'getClientListFacts', summary: 'Phone, visible orders count and last order of the given clients' })
  @Get('list-facts')
  list(@Req() request: RequestWithCurrentUser, @Query() query: unknown): Promise<ClientListFactsResponseDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const parsed = querySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный список клиентов', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.code),
      });
    }
    return this.facts.facts(request.user, parsed.data.ids, request.requestId ?? randomUUID());
  }
}
