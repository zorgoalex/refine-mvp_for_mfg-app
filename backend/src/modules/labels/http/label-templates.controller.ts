import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { LabelsService } from '../application/labels.service';
import type { LabelRendererCapabilitiesDto, LabelTemplateDto, LabelsContext } from '../application/labels.types';
import {
  createLabelTemplateSchema,
  deleteLabelTemplateSchema,
  updateLabelTemplateSchema,
} from '../dto/label-template.dto';
import { assertLabelsEnabled, requireUser } from './label-fields.controller';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('label-templates')
export class LabelTemplatesController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listLabelTemplates', summary: 'List label templates' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<LabelTemplateDto[]> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.listTemplates({ ...this.context(request), includeInactive: includeInactive === 'true' });
  }

  @ApiOperation({ operationId: 'getLabelRendererCapabilities', summary: 'Get label renderer capabilities' })
  @Get('renderer-capabilities')
  async capabilities(@Req() request: RequestWithCurrentUser): Promise<LabelRendererCapabilitiesDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.getRendererCapabilities(this.context(request));
  }

  @ApiOperation({ operationId: 'getLabelTemplate', summary: 'Get label template' })
  @Get(':id')
  async getById(@Req() request: RequestWithCurrentUser, @Param('id') id: string): Promise<LabelTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.getTemplateById({ ...this.context(request), id: parseId(id) });
  }

  @ApiOperation({ operationId: 'createLabelTemplate', summary: 'Create label template' })
  @Post()
  @HttpCode(200)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<LabelTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.createTemplate({ ...this.context(request), input: parse(createLabelTemplateSchema, body) });
  }

  @ApiOperation({ operationId: 'updateLabelTemplate', summary: 'Update label template' })
  @Put(':id')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LabelTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    const { version, ...input } = parse(updateLabelTemplateSchema, body);
    return this.service.updateTemplate({
      ...this.context(request),
      id: parseId(id),
      expectedVersion: version,
      input,
    });
  }

  @ApiOperation({ operationId: 'deleteLabelTemplate', summary: 'Delete label template' })
  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    assertLabelsEnabled(this.runtimeConfig);
    const parsed = parse(deleteLabelTemplateSchema, body);
    await this.service.deleteTemplate({
      ...this.context(request),
      id: parseId(id),
      expectedVersion: parsed.version,
      idempotencyKey: parsed.idempotencyKey,
    });
  }

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}

export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid label template id', { field: 'id' });
  }
  return id;
}

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Label payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  return parsed.data;
}
