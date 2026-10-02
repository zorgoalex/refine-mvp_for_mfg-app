import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { SupplierTextTemplatesService } from '../application/supplier-text-templates.service';
import type { SupplierTextTemplateCommandResultDto, SupplierTextTemplatesListDto } from '../application/supplier-text-templates.types';
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

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('procurement/supplier-text-templates')
export class SupplierTextTemplatesController {
  constructor(
    @Inject(SupplierTextTemplatesService) private readonly templates: SupplierTextTemplatesService,
    @Inject(OrdersRuntimeConfigService) private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiResponse({ status: 200, description: 'Active supplier text templates (default first) and whether the user can edit them' })
  @ApiResponse({ status: 503, description: 'Supplier requests or text templates are disabled' })
  @ApiOperation({ operationId: 'listSupplierTextTemplates', summary: 'Supplier request text templates' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser): Promise<SupplierTextTemplatesListDto> {
    return this.templates.list(this.requireEnabled(request, false));
  }

  @ApiResponse({ status: 200, description: 'Created; a repeat with the same commandKey and body returns the stored result' })
  @ApiResponse({ status: 409, description: 'Name taken, limit reached or commandKey reused with another body' })
  @ApiResponse({ status: 422, description: 'Invalid template' })
  @ApiOperation({ operationId: 'createSupplierTextTemplate', summary: 'Create a supplier text template' })
  @Post()
  @HttpCode(200)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(createTemplateSchema, body);
    return this.templates.create({ ...input, currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  @ApiResponse({ status: 200, description: 'Updated (no-op when unchanged)' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Stale version or name taken' })
  @ApiOperation({ operationId: 'updateSupplierTextTemplate', summary: 'Update a supplier text template' })
  @Patch(':templateId')
  async update(@Req() request: RequestWithCurrentUser, @Param('templateId') templateId: string, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(updateTemplateSchema, body);
    return this.templates.update({ ...input, templateId: parseId(templateId), currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  @ApiResponse({ status: 200, description: 'Deleted (soft)' })
  @ApiResponse({ status: 409, description: 'Stale version, the default or the last template' })
  @ApiOperation({ operationId: 'deleteSupplierTextTemplate', summary: 'Delete a supplier text template' })
  @Delete(':templateId')
  @HttpCode(200)
  async remove(@Req() request: RequestWithCurrentUser, @Param('templateId') templateId: string, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(versionSchema, body);
    return this.templates.remove({ ...input, templateId: parseId(templateId), currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  @ApiResponse({ status: 200, description: 'Default template set (no-op when already default)' })
  @ApiResponse({ status: 409, description: 'Stale version' })
  @ApiOperation({ operationId: 'setDefaultSupplierTextTemplate', summary: 'Make a supplier text template the default' })
  @Post(':templateId/default')
  @HttpCode(200)
  async setDefault(@Req() request: RequestWithCurrentUser, @Param('templateId') templateId: string, @Body() body: unknown): Promise<SupplierTextTemplateCommandResultDto> {
    const user = this.requireEnabled(request, true);
    const input = parse(versionSchema, body);
    return this.templates.setDefault({ ...input, templateId: parseId(templateId), currentUser: user, requestId: request.requestId ?? 'unknown' });
  }

  private requireEnabled(request: RequestWithCurrentUser, write: boolean): CurrentUser {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', { feature: 'orders' });
    if (write && flags.ordersReadOnly) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is read-only', { feature: 'orders' });
    if (flags.resourceProcurementEnabled !== true || flags.procurementWorkspaceEnabled !== true || flags.supplierRequestsEnabled !== true
      || flags.supplierTextTemplatesEnabled !== true) {
      throw new ApiError(503, 'SUPPLIER_TEXT_TEMPLATES_DISABLED', 'Шаблоны текста поставщику пока выключены', { feature: 'supplierTextTemplates' });
    }
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
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
