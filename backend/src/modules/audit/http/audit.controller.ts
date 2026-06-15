import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { AuditLogListResponseDto } from '../dto/audit.dto';
import { AuditQueryService } from '../application/audit-query.service';
import type { ListAuditCommand } from '../application/audit-query.types';

const numeric = z.coerce.number().int().nonnegative().optional();
const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  event: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  userId: numeric,
  role: z.string().min(1).max(64).optional(),
  source: z.string().min(1).optional(),
  relatedOrderId: numeric,
  relatedClientId: numeric,
  relatedPaymentId: numeric,
  relatedDeadlineId: numeric,
  relatedProductionEventId: numeric,
  relatedUserId: numeric,
  requestId: z.string().min(1).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
});

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseAuditListQuery(
  query: Record<string, string | string[] | undefined>,
): Pick<ListAuditCommand, 'filters' | 'page' | 'pageSize'> {
  const flat: Record<string, string | undefined> = {};
  for (const key of Object.keys(query)) flat[key] = firstQueryValue(query[key]);
  const result = querySchema.safeParse(flat);
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid audit list query', { issues: result.error.issues });
  }
  const { page, pageSize, ...filters } = result.data;
  // strip undefined keys so the WHERE builder stays minimal
  const cleaned = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
  return { page, pageSize, filters: cleaned };
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(@Inject(AuditQueryService) private readonly audit: Pick<AuditQueryService, 'list'>) {}

  @ApiOperation({ summary: 'Список audit events', description: 'Возвращает постраничный список audit log событий с фильтрами по actor, entity, related ids, action и времени. Требует право audit.view.' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AuditLogListResponseDto> {
    const parsed = parseAuditListQuery(query);
    return this.audit.list({
      currentUser: request.user,
      filters: parsed.filters,
      page: parsed.page,
      pageSize: parsed.pageSize,
      requestId: request.requestId ?? 'audit-list',
    });
  }
}
