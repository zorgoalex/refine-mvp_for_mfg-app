import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type {
  AuditFilterOptionsResponseDto,
  AuditLogListResponseDto,
  AuditOrderFilterOptionsResponseDto,
  AuditParticipantFilterOptionsResponseDto,
} from '../dto/audit.dto';
import { AuditQueryService } from '../application/audit-query.service';
import type { AuditLogFilters, AuditLookupQuery, ListAuditCommand } from '../application/audit-query.types';

const MAX_ARRAY_VALUES = 100;
const MAX_EVENT_LENGTH = 128;
const MAX_LOOKUP_SEARCH_LENGTH = 80;
const MAX_LOOKUP_LIMIT = 50;

const numeric = z.coerce.number().int().positive().optional();
const scopeSchema = z.enum(['all', 'business']).default('all');
const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  event: z.string().min(1).max(MAX_EVENT_LENGTH).optional(),
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
  relatedEntityType: z.string().min(1).optional(),
  relatedEntityId: numeric,
  requestId: z.string().min(1).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  scope: scopeSchema,
});

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function queryValues(query: Record<string, string | string[] | undefined>, key: string): string[] {
  const value = query[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function splitQueryValues(values: readonly string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function failValidation(message: string, path: string): never {
  throw new ApiError(422, 'VALIDATION_ERROR', message, { issues: [{ path: [path], message }] });
}

function parseStringArrayParam(
  query: Record<string, string | string[] | undefined>,
  key: string,
  max: number,
  maxLength: number,
): string[] {
  const values = splitQueryValues(queryValues(query, key));
  if (values.length > max) failValidation(`Too many ${key} values`, key);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length > maxLength) failValidation(`${key} value is too long`, key);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parsePositiveIntArrayParam(
  query: Record<string, string | string[] | undefined>,
  key: string,
  max: number,
): number[] {
  const values = splitQueryValues(queryValues(query, key));
  if (values.length > max) failValidation(`Too many ${key} values`, key);
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!/^[1-9][0-9]*$/.test(value)) failValidation(`Invalid ${key} value`, key);
    const numericValue = Number(value);
    if (!Number.isSafeInteger(numericValue)) failValidation(`Invalid ${key} value`, key);
    if (seen.has(numericValue)) continue;
    seen.add(numericValue);
    result.push(numericValue);
  }
  return result;
}

function mergeUnique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function assertMaxArrayLength(values: readonly unknown[], key: string, max: number): void {
  if (values.length > max) failValidation(`Too many ${key} values`, key);
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
  const events = parseStringArrayParam(query, 'events', MAX_ARRAY_VALUES, MAX_EVENT_LENGTH);
  const orderIds = parsePositiveIntArrayParam(query, 'orderIds', MAX_ARRAY_VALUES);
  const participantUserIds = parsePositiveIntArrayParam(query, 'participantUserIds', MAX_ARRAY_VALUES);
  const normalized: AuditLogFilters = { ...filters };
  if (events.length > 0) {
    normalized.events = mergeUnique([...(normalized.event ? [normalized.event] : []), ...events]);
    assertMaxArrayLength(normalized.events, 'events', MAX_ARRAY_VALUES);
    delete normalized.event;
  }
  if (orderIds.length > 0) {
    normalized.orderIds = mergeUnique([
      ...(normalized.relatedOrderId != null ? [normalized.relatedOrderId] : []),
      ...orderIds,
    ]);
    assertMaxArrayLength(normalized.orderIds, 'orderIds', MAX_ARRAY_VALUES);
    delete normalized.relatedOrderId;
  }
  if (normalized.scope === 'business') {
    const participantIds = mergeUnique([
      ...(normalized.userId != null ? [normalized.userId] : []),
      ...(normalized.relatedUserId != null ? [normalized.relatedUserId] : []),
      ...participantUserIds,
    ]);
    assertMaxArrayLength(participantIds, 'participantUserIds', MAX_ARRAY_VALUES);
    if (participantIds.length > 0) normalized.participantUserIds = participantIds;
    delete normalized.userId;
    delete normalized.relatedUserId;
  } else if (participantUserIds.length > 0) {
    normalized.participantUserIds = participantUserIds;
  }
  if (normalized.scope === 'all') delete normalized.scope;
  // strip undefined keys so the WHERE builder stays minimal
  const cleaned = Object.fromEntries(Object.entries(normalized).filter(([, v]) => v !== undefined));
  return { page, pageSize, filters: cleaned };
}

export function parseAuditFilterOptionsQuery(
  query: Record<string, string | string[] | undefined>,
): { scope: 'all' | 'business' } {
  const result = z.object({ scope: scopeSchema }).safeParse({ scope: firstQueryValue(query.scope) });
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid audit filter options query', { issues: result.error.issues });
  }
  return { scope: result.data.scope };
}

export function parseAuditLookupQuery(query: Record<string, string | string[] | undefined>): AuditLookupQuery {
  const ids = parsePositiveIntArrayParam(query, 'ids', MAX_ARRAY_VALUES);
  const searchValue = firstQueryValue(query.search)?.trim();
  if (searchValue && searchValue.length > MAX_LOOKUP_SEARCH_LENGTH) {
    failValidation('search value is too long', 'search');
  }
  const result = z
    .object({
      limit: z.coerce.number().int().positive().max(MAX_LOOKUP_LIMIT).default(20),
    })
    .safeParse({ limit: firstQueryValue(query.limit) });
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid audit lookup query', { issues: result.error.issues });
  }
  return {
    limit: result.data.limit,
    ...(ids.length > 0 ? { ids } : {}),
    ...(searchValue ? { search: searchValue } : {}),
  };
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(
    @Inject(AuditQueryService)
    private readonly audit: Pick<
      AuditQueryService,
      'list' | 'filterOptions' | 'orderOptions' | 'participantOptions'
    >,
  ) {}

  @ApiOperation({ summary: 'Значения фильтров audit', description: 'Возвращает distinct-значения для выпадающих списков фильтров журнала аудита. Требует право audit.view.' })
  @Get('filter-options')
  async filterOptions(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AuditFilterOptionsResponseDto> {
    const parsed = parseAuditFilterOptionsQuery(query);
    return this.audit.filterOptions({
      currentUser: request.user,
      requestId: request.requestId ?? 'audit-filter-options',
      scope: parsed.scope,
    });
  }

  @ApiOperation({ summary: 'Заказы для фильтра audit', description: 'Возвращает минимальный справочник заказов для мультиселекта журнала истории. Требует право audit.view.' })
  @Get('order-options')
  async orderOptions(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AuditOrderFilterOptionsResponseDto> {
    return this.audit.orderOptions({
      currentUser: request.user,
      requestId: request.requestId ?? 'audit-order-options',
      query: parseAuditLookupQuery(query),
    });
  }

  @ApiOperation({ summary: 'Участники для фильтра audit', description: 'Возвращает минимальный справочник пользователей для мультиселекта журнала истории. Требует право audit.view.' })
  @Get('participant-options')
  async participantOptions(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<AuditParticipantFilterOptionsResponseDto> {
    return this.audit.participantOptions({
      currentUser: request.user,
      requestId: request.requestId ?? 'audit-participant-options',
      query: parseAuditLookupQuery(query),
    });
  }

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
