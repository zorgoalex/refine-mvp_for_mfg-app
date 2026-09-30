import { Body, Controller, Get, Inject, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProcurementWorkspaceService } from '../application/procurement-workspace.service';
import {
  PROCUREMENT_SAVED_VIEWS_LIMIT,
  type ProcurementSavedViewDto,
  type ProcurementSettingsDto,
  type ProcurementWorklistQuery,
  type ProcurementWorklistResponseDto,
} from '../application/procurement-workspace.types';
import { withScale } from './onec-documents.controller';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'некорректная дата');
const COVERAGES = ['covered', 'partial', 'ordered', 'none', 'no_data'] as const;

export const worklistQuerySchema = z.object({
  preset: z.enum(['action', 'urgent', 'all']).default('action'),
  search: z.string().trim().max(200).optional().transform((value) => value || undefined),
  dueFrom: dateOnly.optional(),
  dueTo: dateOnly.optional(),
  kind: z.enum(['sheet_material', 'film']).optional(),
  supplierKey: z.string().max(300).regex(/^(none|[scn]:.+)$/).optional(),
  coverage: z.string().max(100).optional().transform((value, ctx) => {
    if (!value) return undefined;
    const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
    for (const item of items) {
      if (!(COVERAGES as readonly string[]).includes(item)) {
        ctx.addIssue({ code: "custom", message: `неизвестное покрытие: ${item}` });
        return z.NEVER;
      }
    }
    return items as ProcurementWorklistQuery['coverage'];
  }),
  onecDocumentId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  groupBy: z.enum(['none', 'supplier', 'material']).default('none'),
  sort: z.enum(['due', 'deficit', 'order', 'material']).default('due'),
}).strict().refine((query) => !query.dueFrom || !query.dueTo || query.dueFrom <= query.dueTo, {
  message: 'dueFrom позже dueTo', path: ['dueFrom'],
});

export const settingsSchema = z.object({
  leadDays: z.number().int().min(0).max(60),
  criticalDays: z.number().int().min(0).max(60),
  soonDays: z.number().int().min(0).max(60),
  wastePercent: z.number().min(0).max(50).refine((value) => value === 0 || withScale(2).safeParse(value).success, 'не больше 2 знаков'),
  digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  unallocatedAlertDays: z.number().int().min(1).max(30),
  overdueWindowDays: z.number().int().min(1).max(365),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict().refine((value) => value.criticalDays <= value.soonDays, {
  message: '«Критично» не может быть больше «Скоро»', path: ['criticalDays'],
});

export const savedViewsSchema = z.object({
  views: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    query: z.string().max(1000).refine((value) => !value.startsWith('?'), 'без «?» в начале'),
  }).strict()).max(PROCUREMENT_SAVED_VIEWS_LIMIT),
}).strict().refine((value) => new Set(value.views.map((view) => view.id)).size === value.views.length, {
  message: 'повторяющийся id представления', path: ['views'],
});

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('procurement')
export class ProcurementWorkspaceController {
  constructor(
    @Inject(ProcurementWorkspaceService) private readonly workspace: ProcurementWorkspaceService,
    @Inject(OrdersRuntimeConfigService) private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Worklist lines order × material with coverage, deficit, due date and supplier' })
  @ApiResponse({ status: 403, description: 'procurement.view required' })
  @ApiResponse({ status: 422, description: 'Invalid query or too many orders/lines' })
  @ApiResponse({ status: 503, description: 'Orders API, procurement or the workspace is disabled' })
  @ApiOperation({ operationId: 'listProcurementWorklist', summary: 'Procurement workspace worklist' })
  @Get('worklist')
  async worklist(@Req() request: RequestWithCurrentUser, @Query() rawQuery: unknown): Promise<ProcurementWorklistResponseDto> {
    const user = this.requireWorkspace(request, false);
    const query = parse(worklistQuerySchema, rawQuery, 'PROCUREMENT_WORKLIST_QUERY_INVALID') as ProcurementWorklistQuery;
    return this.workspace.listWorklist(user, query, {
      procurementEnabled: true,
      supplyWorkspaceEnabled: true,
      supplierRequestsEnabled: this.runtimeConfig.getFeatureFlags().supplierRequestsEnabled === true,
    });
  }

  @ApiResponse({ status: 200, description: 'Saved worklist views of the current user' })
  @ApiResponse({ status: 503, description: 'Workspace is disabled' })
  @ApiOperation({ operationId: 'getProcurementSavedViews', summary: 'Saved worklist views' })
  @Get('worklist/saved-views')
  async savedViews(@Req() request: RequestWithCurrentUser): Promise<{ views: ProcurementSavedViewDto[] }> {
    const user = this.requireWorkspace(request, false);
    return { views: await this.workspace.getSavedViews(user) };
  }

  @ApiResponse({ status: 200, description: 'Saved views replaced' })
  @ApiResponse({ status: 422, description: 'Invalid views' })
  @ApiResponse({ status: 503, description: 'Workspace is disabled' })
  @ApiOperation({ operationId: 'replaceProcurementSavedViews', summary: 'Replace saved worklist views' })
  @Put('worklist/saved-views')
  async replaceSavedViews(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<{ views: ProcurementSavedViewDto[] }> {
    const user = this.requireWorkspace(request, false);
    const input = parse(savedViewsSchema, body, 'PROCUREMENT_SAVED_VIEWS_INVALID');
    return { views: await this.workspace.replaceSavedViews(user, input.views) };
  }

  @ApiResponse({ status: 200, description: 'Procurement workspace settings' })
  @ApiResponse({ status: 403, description: 'procurement.view or settings.manage required' })
  @ApiOperation({ operationId: 'getProcurementSettings', summary: 'Procurement workspace settings' })
  @Get('settings')
  async settings(@Req() request: RequestWithCurrentUser): Promise<ProcurementSettingsDto> {
    return this.workspace.getSettings(this.requireOrders(request, false));
  }

  @ApiResponse({ status: 200, description: 'Settings after the update (no-op when unchanged)' })
  @ApiResponse({ status: 403, description: 'settings.manage required' })
  @ApiResponse({ status: 409, description: 'Stale version' })
  @ApiResponse({ status: 422, description: 'Invalid settings' })
  @ApiOperation({ operationId: 'updateProcurementSettings', summary: 'Update procurement workspace settings' })
  @Put('settings')
  async updateSettings(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<ProcurementSettingsDto & { changed: boolean }> {
    const user = this.requireOrders(request, true);
    const { expectedVersion, ...settings } = parse(settingsSchema, body, 'PROCUREMENT_SETTINGS_INVALID');
    const result = await this.workspace.updateSettings({
      currentUser: user,
      requestId: request.requestId ?? 'unknown',
      settings,
      expectedVersion,
    });
    return { ...result.settings, changed: result.changed };
  }

  private requireOrders(request: RequestWithCurrentUser, write: boolean): CurrentUser {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
    }
    if (write && flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is read-only', { feature: 'orders' });
    }
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }

  private requireWorkspace(request: RequestWithCurrentUser, write: boolean): CurrentUser {
    const user = this.requireOrders(request, write);
    const flags = this.runtimeConfig.getFeatureFlags();
    if (flags.resourceProcurementEnabled !== true || flags.procurementWorkspaceEnabled !== true) {
      throw new ApiError(503, 'PROCUREMENT_WORKSPACE_DISABLED', 'Экран снабжения пока выключен', { feature: 'procurementWorkspace' });
    }
    return user;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(422, code, 'Некорректные данные запроса', {
      issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
