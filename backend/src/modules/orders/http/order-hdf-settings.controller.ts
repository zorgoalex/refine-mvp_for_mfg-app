import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderHdfSettingsService, type HdfSettingsDto } from '../application/order-hdf-settings.service';

const hdfSettingsBodySchema = z.object({
  minSideThresholdMm: z.number().positive().optional(),
  minSideThresholdVersion: z.number().int().positive().optional(),
  sheetMaterialTypeId: z.number().int().positive().nullable().optional(),
  sheetMaterialVersion: z.number().int().positive().optional(),
}).strict();

const millingExtraResourceBodySchema = z.object({
  id: z.number().int().positive().optional(),
  version: z.number().int().positive().optional(),
  extraResourceId: z.number().int().positive().nullable().optional(),
  resourceKind: z.string().trim().min(1).max(50).optional(),
  resourceRefType: z.string().trim().min(1).max(50).nullable().optional(),
  resourceRefId: z.number().int().positive().nullable().optional(),
  resourceName: z.string().trim().min(1).max(200).optional(),
  unitId: z.number().int().positive().nullable().optional(),
  accountingMethod: z.string().trim().max(500).optional(),
  parameterName: z.string().trim().max(100).optional(),
  parameterMm: z.number().positive().nullable().optional(),
  hdfAutoEnabled: z.boolean().optional(),
  comment: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(32767).optional(),
}).strict();

const extraResourceBodySchema = z.object({
  version: z.number().int().positive().optional(),
  resourceKind: z.string().trim().min(1).max(50),
  resourceRefType: z.string().trim().min(1).max(50).nullable().optional(),
  resourceRefId: z.number().int().positive().nullable().optional(),
  resourceName: z.string().trim().min(1).max(200),
  unitId: z.number().int().positive().nullable().optional(),
  accountingMethod: z.string().trim().max(500).optional(),
  defaultParameterName: z.string().trim().max(100).optional(),
  defaultParameterMm: z.number().positive().nullable().optional(),
  hdfAutoDefault: z.boolean().optional(),
  comment: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(32767).optional(),
}).strict();

const hdfMillingBodySchema = z.object({
  hdfEnabled: z.boolean().optional(),
  hdfEdgeMm: z.number().positive().nullable().optional(),
  hdfParameterName: z.string().trim().max(100).nullable().optional(),
  extraResources: z.array(millingExtraResourceBodySchema).optional(),
  expectedVersion: z.number().int().positive(),
}).strict();

@ApiTags('ProductionTechSettings')
@ApiBearerAuth()
@Controller('production-tech-settings/hdf')
export class OrderHdfSettingsController {
  constructor(
    @Inject(OrderHdfSettingsService) private readonly service: OrderHdfSettingsService,
  ) {}

  @ApiOperation({ operationId: 'getHdfProductionTechSettings', summary: 'Read HDF production tech settings' })
  @Get()
  async get(@Req() request: RequestWithCurrentUser): Promise<HdfSettingsDto> {
    return this.service.get(requireCurrentUser(request));
  }

  @ApiOperation({ operationId: 'listExtraResources', summary: 'List independent extra resources directory' })
  @Get('extra-resources')
  async listExtraResources(@Req() request: RequestWithCurrentUser) {
    return this.service.getExtraResources(requireCurrentUser(request));
  }

  @ApiOperation({ operationId: 'createExtraResource', summary: 'Create independent extra resource directory item' })
  @Post('extra-resources')
  async createExtraResource(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: unknown,
  ) {
    const parsed = parse(extraResourceBodySchema, body);
    return this.service.createExtraResource({
      currentUser: requireCurrentUser(request),
      ...parsed,
      idempotencyKey: parseIdempotencyKey(idempotencyKeyHeader),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'updateExtraResource', summary: 'Update independent extra resource directory item' })
  @Put('extra-resources/:extraResourceId')
  async updateExtraResource(
    @Req() request: RequestWithCurrentUser,
    @Param('extraResourceId') extraResourceIdParam: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: unknown,
  ) {
    const parsed = parse(extraResourceBodySchema, body);
    return this.service.updateExtraResource({
      currentUser: requireCurrentUser(request),
      id: parseId(extraResourceIdParam),
      ...parsed,
      idempotencyKey: parseIdempotencyKey(idempotencyKeyHeader),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'updateHdfProductionTechSettings', summary: 'Update HDF production tech settings' })
  @Put()
  async update(
    @Req() request: RequestWithCurrentUser,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<HdfSettingsDto> {
    const parsed = parse(hdfSettingsBodySchema, body);
    return this.service.update({
      currentUser: requireCurrentUser(request),
      minSideThresholdMm: parsed.minSideThresholdMm,
      minSideThresholdVersion: parsed.minSideThresholdVersion,
      sheetMaterialTypeId: parsed.sheetMaterialTypeId,
      sheetMaterialVersion: parsed.sheetMaterialVersion,
      idempotencyKey: parseIdempotencyKey(idempotencyKeyHeader),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'updateHdfMillingSettings', summary: 'Update HDF fields on a milling type' })
  @Put('milling-types/:millingTypeId')
  async updateMilling(
    @Req() request: RequestWithCurrentUser,
    @Param('millingTypeId') millingTypeIdParam: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<{ success: true }> {
    const parsed = parse(hdfMillingBodySchema, body);
    await this.service.updateMilling({
      currentUser: requireCurrentUser(request),
      millingTypeId: parseId(millingTypeIdParam),
      hdfEnabled: parsed.hdfEnabled,
      hdfEdgeMm: parsed.hdfEdgeMm,
      hdfParameterName: parsed.hdfParameterName,
      extraResources: parsed.extraResources,
      expectedVersion: parsed.expectedVersion,
      idempotencyKey: parseIdempotencyKey(idempotencyKeyHeader),
      requestId: request.requestId,
    });
    return { success: true };
  }
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}

function parseId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid id');
  }
  return parsed;
}

function parseIdempotencyKey(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = typeof raw === 'string' ? raw.trim() : '';
  if (normalized.length < 8 || normalized.length > 200) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid Idempotency-Key');
  }
  return normalized;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'HDF settings payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  return parsed.data;
}
