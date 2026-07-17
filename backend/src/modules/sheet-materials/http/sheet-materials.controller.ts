import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { SheetMaterialsService } from '../application/sheet-materials.service';
import type { SheetMaterialsContext, SheetMaterialTypeDto } from '../application/sheet-materials.types';
import { SheetMaterialsRuntimeConfigService } from './sheet-materials-runtime-config.service';

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  materialTypeId: z.number().int().positive(),
  unitId: z.number().int().positive(),
  thicknessMm: z.number().positive(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  supplierId: z.number().int().positive().nullable().optional(),
  vendorId: z.number().int().positive().nullable().optional(),
  supplierArticle: z.string().trim().max(200).nullable().optional(),
  texture: z.boolean().nullable().optional(),
  color: z.string().trim().max(100).nullable().optional(),
  // Postgres `uuid` accepts any 8-4-4-4-12 hex; 1C GUIDs are not always RFC-4122 (version/variant
  // nibbles vary), so use the same lenient form as the column + the service validation, NOT z.uuid().
  // Accept a valid hex UUID, an empty string (form clears -> normalized to null in the repo), null, or
  // omitted (.nullish()). Avoids z.preprocess(), which Zod 4 treats as a required key.
  refKey1c: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'refKey1c must be a UUID')
    .or(z.literal(''))
    .nullish(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(-32768).max(32767).optional(),
});
const createSchema = inputSchema.strict();
const updateSchema = inputSchema.extend({ version: z.number().int().min(0) }).strict();
const versionBodySchema = z.object({ version: z.number().int().min(0) }).strict();

@ApiTags('SheetMaterials')
@ApiBearerAuth()
@Controller('sheet-material-types')
export class SheetMaterialsController {
  constructor(
    private readonly service: SheetMaterialsService,
    private readonly runtimeConfig: SheetMaterialsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listSheetMaterialTypes', summary: 'List sheet material types' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<SheetMaterialTypeDto[]> {
    this.assertEnabled();
    const ctx = this.context(request);
    return this.service.list({ ...ctx, includeInactive: includeInactive === 'true' });
  }

  @ApiOperation({ operationId: 'getSheetMaterialType', summary: 'Get a sheet material type' })
  @Get(':id')
  async getById(@Req() request: RequestWithCurrentUser, @Param('id') id: string): Promise<SheetMaterialTypeDto> {
    this.assertEnabled();
    const ctx = this.context(request);
    return this.service.getById({ ...ctx, id: parseId(id) });
  }

  @ApiOperation({ operationId: 'createSheetMaterialType', summary: 'Create a sheet material type' })
  @Post()
  @HttpCode(200)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<SheetMaterialTypeDto> {
    this.assertEnabled();
    const ctx = this.context(request);
    return this.service.create({ ...ctx, input: parse(createSchema, body) });
  }

  @ApiOperation({ operationId: 'updateSheetMaterialType', summary: 'Update a sheet material type' })
  @Put(':id')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SheetMaterialTypeDto> {
    this.assertEnabled();
    const ctx = this.context(request);
    const { version, ...input } = parse(updateSchema, body);
    return this.service.update({ ...ctx, id: parseId(id), expectedVersion: version, input });
  }

  @ApiOperation({ operationId: 'deactivateSheetMaterialType', summary: 'Deactivate a sheet material type' })
  @Delete(':id')
  @HttpCode(204)
  async deactivate(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    this.assertEnabled();
    const ctx = this.context(request);
    await this.service.deactivate({ ...ctx, id: parseId(id), expectedVersion: parse(versionBodySchema, body).version });
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().sheetMaterialsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Sheet materials API is disabled', { feature: 'sheet_materials' });
    }
  }

  private context(request: RequestWithCurrentUser): SheetMaterialsContext {
    const user = this.requireUser(request);
    return { currentUser: user, requestId: request.requestId ?? '' };
  }

  private requireUser(request: RequestWithCurrentUser): CurrentUser {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return request.user;
  }
}

export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid sheet material type id', { field: 'id' });
  }
  return id;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Sheet material payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  return parsed.data;
}
