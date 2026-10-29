import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { DuplicateJournalRepository, type DuplicateListQuery } from './duplicate-journal.repository';
import { RULES_BY_CODE } from './duplicate-rules';
import { DUPLICATE_ENTITY_KINDS, DUPLICATE_REASONS, DUPLICATE_STATUSES, DUPLICATE_SYSTEMS, DUPLICATES_RESOLVE, DUPLICATES_VIEW } from './integration-duplicates';

const listSchema = z.object({
  status: z.enum([...DUPLICATE_STATUSES, 'all']).default('open'),
  entityKind: z.enum(DUPLICATE_ENTITY_KINDS).optional(),
  ruleCode: z.string().max(80).optional(),
  system: z.enum(DUPLICATE_SYSTEMS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

const decisionSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.enum(DUPLICATE_REASONS).nullable().optional(),
}).strict();

/** The journal of duplicates of integrations («Интеграции → Дубли»). */
@ApiTags('Integration duplicates')
@ApiBearerAuth('bearerAuth')
@Controller('integration-duplicates')
@UseGuards(PermissionsGuard)
export class IntegrationDuplicatesController {
  constructor(@Inject(DuplicateJournalRepository) private readonly journal: DuplicateJournalRepository) {}

  @ApiOperation({ summary: 'Cases of duplicates (filters, page, counts per status); names and values by the rights of their sources' })
  @Get() @RequirePermissions([DUPLICATES_VIEW])
  async list(@Query() query: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Неверные параметры списка', { issues: parsed.error.issues });
    const q = parsed.data;
    if (q.ruleCode && !RULES_BY_CODE.has(q.ruleCode)) throw new ApiError(422, 'VALIDATION_FAILED', 'Неизвестное правило');
    const filter: DuplicateListQuery = {
      status: q.status, entityKind: q.entityKind ?? null, ruleCode: q.ruleCode ?? null, system: q.system ?? null,
      from: q.from ?? null, to: q.to ?? null, search: q.search || null, page: q.page, pageSize: q.pageSize,
    };
    return this.journal.list(actor(request).user, filter);
  }

  @ApiOperation({ summary: 'Rules of the journal (for the filter)' })
  @Get('rules') @RequirePermissions([DUPLICATES_VIEW])
  rules() {
    return [...RULES_BY_CODE.values()].map((rule) => ({ code: rule.code, label: rule.label, entityKind: rule.entityKind, strength: rule.strength, external: rule.external }));
  }

  @ApiOperation({ summary: 'One case: members with their facts, matched values, history, other cases of the same records' })
  @Get(':caseId') @RequirePermissions([DUPLICATES_VIEW])
  async card(@Param('caseId') caseId: string, @Req() request: RequestWithCurrentUser) {
    return this.journal.card(actor(request).user, parseCaseId(caseId));
  }

  @ApiOperation({ summary: 'Mark a case «Не дубль» (compare-and-swap on the version)' })
  @Post(':caseId/dismiss') @HttpCode(200) @RequirePermissions([DUPLICATES_VIEW, DUPLICATES_RESOLVE])
  async dismiss(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    return this.decide('dismiss', caseId, body, request);
  }

  @ApiOperation({ summary: 'Mark a case of 1C data «Исправить в 1С»' })
  @Post(':caseId/external') @HttpCode(200) @RequirePermissions([DUPLICATES_VIEW, DUPLICATES_RESOLVE])
  async external(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    return this.decide('external', caseId, body, request);
  }

  @ApiOperation({ summary: 'Open a dismissed or external case again' })
  @Post(':caseId/reopen') @HttpCode(200) @RequirePermissions([DUPLICATES_VIEW, DUPLICATES_RESOLVE])
  async reopen(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    return this.decide('reopen', caseId, body, request);
  }

  private async decide(action: 'dismiss' | 'external' | 'reopen', caseId: string, body: unknown, request: RequestWithCurrentUser) {
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Неверный запрос', { issues: parsed.error.issues });
    if (action === 'dismiss' && !parsed.data.reason) throw new ApiError(422, 'VALIDATION_FAILED', 'Укажите причину');
    const { user, requestId } = actor(request);
    return this.journal.decide(user, parseCaseId(caseId), action, parsed.data.expectedVersion, parsed.data.reason ?? null, requestId);
  }
}

function parseCaseId(value: string): number {
  if (!/^\d{1,15}$/.test(value)) throw new ApiError(404, 'DUPLICATE_CASE_NOT_FOUND', 'Дело дубля не найдено');
  return Number(value);
}

function actor(request: RequestWithCurrentUser): { user: CurrentUser; requestId: string } {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return { user: request.user, requestId: request.requestId };
}
