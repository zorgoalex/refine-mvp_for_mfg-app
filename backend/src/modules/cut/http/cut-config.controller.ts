import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CutConfigAdminService } from '../application/cut-config-admin.service';
import type {
  CutConfigDto,
  CutParamProfileDto,
  CutPdfTemplateDto,
  CutRenderPresetDto,
  CutSettingRowDto,
} from '../application/cut-config-admin.types';
import { CutRuntimeConfigService } from './cut-runtime-config.service';

const settingBodySchema = z.object({ value: z.unknown(), version: z.number().int().min(0) }).strict();

const profileInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  params: z.record(z.string(), z.unknown()),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const profileCreateSchema = profileInputSchema.strict();
const profileUpdateSchema = profileInputSchema.extend({ version: z.number().int().min(0) }).strict();

const presetInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  targetPx: z.number().int().positive(),
  background: z.string().optional(),
  isActive: z.boolean().optional(),
});
const presetCreateSchema = presetInputSchema.strict();
const presetUpdateSchema = presetInputSchema.extend({ version: z.number().int().min(0) }).strict();

const pdfTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  layout: z.record(z.string(), z.unknown()),
  isActive: z.boolean().optional(),
  version: z.number().int().min(0),
}).strict();
const pdfTemplateCreateSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(100),
  name: z.string().trim().min(1).max(200),
  layout: z.record(z.string(), z.unknown()),
  isActive: z.boolean().optional(),
}).strict();

const versionBodySchema = z.object({ version: z.number().int().min(0) }).strict();

@ApiTags('CutConfig')
@ApiBearerAuth()
@Controller('cut-config')
export class CutConfigController {
  constructor(
    @Inject(CutConfigAdminService) private readonly config: CutConfigAdminService,
    @Inject(CutRuntimeConfigService) private readonly runtimeConfig: CutRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'getCutConfig', summary: 'Read the cut configuration (settings + catalogs)' })
  @Get()
  async get(@Req() request: RequestWithCurrentUser): Promise<CutConfigDto> {
    const currentUser = this.requireRead(request);
    return this.config.getConfig({ currentUser, requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'updateCutSetting', summary: 'Update a cut_settings rule set' })
  @Put('settings/:key')
  async updateSetting(
    @Req() request: RequestWithCurrentUser,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<CutSettingRowDto> {
    const currentUser = this.requireMutation(request);
    const parsed = parse(settingBodySchema, body);
    return this.config.updateSetting({
      currentUser,
      key,
      value: parsed.value,
      expectedVersion: parsed.version,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'createCutParamProfile', summary: 'Create a freecut param profile' })
  @Post('param-profiles')
  async createProfile(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CutParamProfileDto> {
    const currentUser = this.requireMutation(request);
    return this.config.upsertParamProfile({ currentUser, input: parse(profileCreateSchema, body), requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'updateCutParamProfile', summary: 'Update a freecut param profile' })
  @Put('param-profiles/:id')
  async updateProfile(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<CutParamProfileDto> {
    const currentUser = this.requireMutation(request);
    const { version, ...input } = parse(profileUpdateSchema, body);
    return this.config.upsertParamProfile({ currentUser, cutParamProfileId: parseId(id), expectedVersion: version, input, requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'deleteCutParamProfile', summary: 'Deactivate a freecut param profile' })
  @Delete('param-profiles/:id')
  async deleteProfile(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    const currentUser = this.requireMutation(request);
    await this.config.deleteParamProfile({ currentUser, id: parseId(id), expectedVersion: parseVersion(body), requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'createCutRenderPreset', summary: 'Create a render preset' })
  @Post('render-presets')
  async createPreset(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CutRenderPresetDto> {
    const currentUser = this.requireMutation(request);
    return this.config.upsertRenderPreset({ currentUser, input: parse(presetCreateSchema, body), requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'updateCutRenderPreset', summary: 'Update a render preset' })
  @Put('render-presets/:id')
  async updatePreset(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<CutRenderPresetDto> {
    const currentUser = this.requireMutation(request);
    const { version, ...input } = parse(presetUpdateSchema, body);
    return this.config.upsertRenderPreset({ currentUser, cutRenderPresetId: parseId(id), expectedVersion: version, input, requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'deleteCutRenderPreset', summary: 'Deactivate a render preset' })
  @Delete('render-presets/:id')
  async deletePreset(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    const currentUser = this.requireMutation(request);
    await this.config.deleteRenderPreset({ currentUser, id: parseId(id), expectedVersion: parseVersion(body), requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'updateCutPdfTemplate', summary: 'Update a PDF template layout' })
  @Put('pdf-templates/:id')
  async updatePdfTemplate(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<CutPdfTemplateDto> {
    const currentUser = this.requireMutation(request);
    const { version, ...input } = parse(pdfTemplateUpdateSchema, body);
    return this.config.upsertPdfTemplate({ currentUser, id: parseId(id), expectedVersion: version, input, requestId: request.requestId });
  }

  @ApiOperation({ operationId: 'createCutPdfTemplate', summary: 'Create a PDF template layout' })
  @Post('pdf-templates')
  async createPdfTemplate(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CutPdfTemplateDto> {
    const currentUser = this.requireMutation(request);
    return this.config.upsertPdfTemplate({ currentUser, input: parse(pdfTemplateCreateSchema, body), requestId: request.requestId });
  }

  private requireRead(request: RequestWithCurrentUser) {
    this.assertCutEnabled();
    return this.requireCurrentUser(request);
  }

  private requireMutation(request: RequestWithCurrentUser) {
    this.assertCutEnabled();
    if (this.runtimeConfig.getFeatureFlags().cutReadOnly) {
      throw new ApiError(503, 'SERVICE_READ_ONLY', 'Cut jobs API is read-only', { feature: 'cut' });
    }
    return this.requireCurrentUser(request);
  }

  private assertCutEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cutEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Cut jobs API is disabled', { feature: 'cut' });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return request.user;
  }
}

export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid id', { value });
  }
  return id;
}

function parseVersion(body: unknown): number {
  return parse(versionBodySchema, body).version;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Cut config payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  return parsed.data;
}
