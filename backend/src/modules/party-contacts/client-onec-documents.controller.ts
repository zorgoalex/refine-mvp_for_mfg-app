import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import {
  CLIENT_ONEC_DOCUMENT_GROUP_NAMES, CLIENT_ONEC_DOCUMENTS_PAGE_SIZE_MAX, ClientOnecDocumentsService, type ClientOnecDocumentsResponseDto,
} from './client-onec-documents.service';

const querySchema = z.object({
  group: z.enum(CLIENT_ONEC_DOCUMENT_GROUP_NAMES as [string, ...string[]]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(CLIENT_ONEC_DOCUMENTS_PAGE_SIZE_MAX).default(20),
}).strict();

/**
 * Client card, tab «Документы 1С»: documents of the 1C counterparty the client is linked to. Read-only. The rights
 * are checked by the service (literal membership, a refusal is audited), not by a guard.
 */
@ApiTags('Party contacts')
@ApiBearerAuth('bearerAuth')
@Controller('clients')
export class ClientOnecDocumentsController {
  constructor(@Inject(ClientOnecDocumentsService) private readonly documents: ClientOnecDocumentsService) {}

  @ApiOperation({ operationId: 'listClientOnecDocuments', summary: '1C documents of the counterparty of a client within the order visibility of the user, with totals' })
  @Get(':clientId/onec-documents')
  list(@Req() request: RequestWithCurrentUser, @Param('clientId') clientId: string, @Query() query: unknown): Promise<ClientOnecDocumentsResponseDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const id = /^[1-9]\d{0,14}$/.test(clientId) ? Number(clientId) : NaN;
    const parsed = querySchema.safeParse(query ?? {});
    if (!Number.isSafeInteger(id) || !parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный запрос документов 1С клиента');
    const { group, page, pageSize } = parsed.data;
    return this.documents.list(request.user, id, { group: group as (typeof CLIENT_ONEC_DOCUMENT_GROUP_NAMES)[number] | undefined, page, pageSize },
      request.requestId ?? randomUUID());
  }
}
