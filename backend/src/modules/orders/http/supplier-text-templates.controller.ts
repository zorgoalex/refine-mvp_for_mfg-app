import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { SupplierTextTemplatesService } from '../application/supplier-text-templates.service';
import { sharedReadOnly } from '../adapters/pg-supplier-text-templates-repository';
import type {
  MySupplierTextTemplatesListDto,
  SupplierTextTemplateCommandResultDto,
  SupplierTextTemplatesListDto,
} from '../application/supplier-text-templates.types';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const commandKey = z.string().uuid();
const expectedVersion = z.number().int().min(1).max(2147483646);
// Длины и грамматика — в репозитории (одни правила для create/patch); здесь только форма тела.
const text = (max: number) => z.string().max(max);

export const createTemplateSchema = z.object({
  commandKey, name: text(200), body: text(8000), lineTemplate: text(1000),
}).strict();
export const updateTemplateSchema = z.object({
  commandKey, expectedVersion, name: text(200).optional(), body: text(8000).optional(), lineTemplate: text(1000).optional(),
}).strict();
export const versionSchema = z.object({ commandKey, expectedVersion }).strict();
/** Выбор по умолчанию: ещё и ревизия личного выбора, которую видел пользователь (0 — выбора ещё не было). */
export const defaultSchema = z.object({ commandKey, expectedVersion, expectedDefaultRevision: z.number().int().min(0).max(2147483646) }).strict();

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('procurement/my-supplier-text-templates')
export class MySupplierTextTemplatesController {
  constructor(
    @Inject(SupplierTextTemplatesService) private readonly templates: SupplierTextTemplatesService,
    @Inject(OrdersRuntimeConfigService) private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Shared templates and the personal templates of the current user (effective default first)' })
  @ApiResponse({ status: 503, description: 'Supplier requests or text templates are disabled' })
  @ApiOperation({ operationId: 'listMySupplierTextTemplates', summary: 'Supplier text templates visible to the current user' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser): Promise<MySupplierTextTemplatesListDto> {
    return this.templates.listMine(requireEnabled(this.runtimeConfig, request, false));
  }

  @ApiResponse({ status: 200, description: 'Personal template created; a repeat with the same commandKey and body returns the stored result' })
  @ApiResponse({ status: 409, description: 'Name taken, limit reached or commandKey reused with another body' })
  @ApiResponse({ status: 422, description: 'Invalid template' })
  @ApiOperation({ operationId: 'createMySupplierTextTemplate', summary: 'Create a personal supplier text template' })
  @Post()
  @HttpCode(200)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = requireEnabled(this.runtimeConfig, request, true);
    const input = parse(createTemplateSchema, body);
    return this.templates.create({ ...input, currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  @ApiResponse({ status: 200, description: 'Updated (no-op when unchanged)' })
  @ApiResponse({ status: 404, description: 'Template not found (including a personal template of another user)' })
  @ApiResponse({ status: 409, description: 'Stale version, name taken or a shared (read-only) template' })
  @ApiOperation({ operationId: 'updateMySupplierTextTemplate', summary: 'Update a personal supplier text template' })
  @Patch(':templateId')
  async update(@Req() request: RequestWithCurrentUser, @Param('templateId') templateId: string, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = requireEnabled(this.runtimeConfig, request, true);
    const input = parse(updateTemplateSchema, body);
    return this.templates.update({ ...input, templateId: parseId(templateId), currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  @ApiResponse({ status: 200, description: 'Deleted (soft); a personal default pointing at it is cleared' })
  @ApiResponse({ status: 404, description: 'Template not found (including a personal template of another user)' })
  @ApiResponse({ status: 409, description: 'Stale version or a shared (read-only) template' })
  @ApiOperation({ operationId: 'deleteMySupplierTextTemplate', summary: 'Delete a personal supplier text template' })
  @Delete(':templateId')
  @HttpCode(200)
  async remove(@Req() request: RequestWithCurrentUser, @Param('templateId') templateId: string, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = requireEnabled(this.runtimeConfig, request, true);
    const input = parse(versionSchema, body);
    return this.templates.remove({ ...input, templateId: parseId(templateId), currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  @ApiResponse({ status: 200, description: 'Personal default set to an own or a shared template (no-op when already effective)' })
  @ApiResponse({ status: 404, description: 'Template not found (including a personal template of another user)' })
  @ApiResponse({ status: 409, description: 'Stale template version or stale revision of the personal default' })
  @ApiOperation({ operationId: 'setMyDefaultSupplierTextTemplate', summary: 'Choose the default supplier text template of the current user' })
  @Post(':templateId/default')
  @HttpCode(200)
  async setDefault(@Req() request: RequestWithCurrentUser, @Param('templateId') templateId: string, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = requireEnabled(this.runtimeConfig, request, true);
    const input = parse(defaultSchema, body);
    return this.templates.setDefault({ ...input, templateId: parseId(templateId), currentUser: user, requestId: request.requestId ?? 'unknown' });
  }
}

/**
 * Прежний маршрут (FE до личных шаблонов). Чтение — только общие шаблоны. Команды записи отключены: общие шаблоны
 * через API не меняются, а личные ведутся на `procurement/my-supplier-text-templates` — отдельный маршрут нужен,
 * чтобы после отката backend новая вкладка не сохранила личный текст как общий (plan review R2-1).
 */
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('procurement/supplier-text-templates')
export class SupplierTextTemplatesController {
  constructor(
    @Inject(SupplierTextTemplatesService) private readonly templates: SupplierTextTemplatesService,
    @Inject(OrdersRuntimeConfigService) private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Shared supplier text templates (default first); canManage is always false' })
  @ApiResponse({ status: 503, description: 'Supplier requests or text templates are disabled' })
  @ApiOperation({ operationId: 'listSupplierTextTemplates', summary: 'Shared supplier request text templates (read-only)' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser): Promise<SupplierTextTemplatesListDto> {
    return this.templates.listShared(requireEnabled(this.runtimeConfig, request, false));
  }

  @ApiResponse({ status: 409, description: 'Shared templates are read-only' })
  @ApiOperation({ operationId: 'createSupplierTextTemplate', summary: 'Disabled: shared templates are read-only', deprecated: true })
  @Post()
  @HttpCode(200)
  create(@Req() request: RequestWithCurrentUser): never {
    return this.readOnly(request);
  }

  @ApiResponse({ status: 409, description: 'Shared templates are read-only' })
  @ApiOperation({ operationId: 'updateSupplierTextTemplate', summary: 'Disabled: shared templates are read-only', deprecated: true })
  @Patch(':templateId')
  update(@Req() request: RequestWithCurrentUser): never {
    return this.readOnly(request);
  }

  @ApiResponse({ status: 409, description: 'Shared templates are read-only' })
  @ApiOperation({ operationId: 'deleteSupplierTextTemplate', summary: 'Disabled: shared templates are read-only', deprecated: true })
  @Delete(':templateId')
  @HttpCode(200)
  remove(@Req() request: RequestWithCurrentUser): never {
    return this.readOnly(request);
  }

  @ApiResponse({ status: 409, description: 'Shared templates are read-only' })
  @ApiOperation({ operationId: 'setDefaultSupplierTextTemplate', summary: 'Disabled: shared templates are read-only', deprecated: true })
  @Post(':templateId/default')
  @HttpCode(200)
  setDefault(@Req() request: RequestWithCurrentUser): never {
    return this.readOnly(request);
  }

  private readOnly(request: RequestWithCurrentUser): never {
    requireEnabled(this.runtimeConfig, request, true);
    throw sharedReadOnly();
  }
}

function requireEnabled(runtimeConfig: OrdersRuntimeConfigService, request: RequestWithCurrentUser, write: boolean): CurrentUser {
  const flags = runtimeConfig.getFeatureFlags();
  if (!flags.ordersEnabled) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
  if (write && flags.ordersReadOnly) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is read-only', { feature: 'orders' });
  if (flags.resourceProcurementEnabled !== true || flags.procurementWorkspaceEnabled !== true || flags.supplierRequestsEnabled !== true
    || flags.supplierTextTemplatesEnabled !== true) {
    throw new ApiError(503, 'SUPPLIER_TEXT_TEMPLATES_DISABLED', 'Шаблоны текста поставщику пока выключены', { feature: 'supplierTextTemplates' });
  }
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function parseId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(422, 'SUPPLIER_TEXT_TEMPLATE_INVALID', 'Некорректный номер шаблона', { field: 'templateId' });
  }
  return Number(value);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(422, 'SUPPLIER_TEXT_TEMPLATE_INVALID', 'Некорректные данные запроса', {
      issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
