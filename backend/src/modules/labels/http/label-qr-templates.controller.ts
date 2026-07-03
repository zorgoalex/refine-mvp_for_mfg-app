import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { LabelsService } from '../application/labels.service';
import type { LabelQrTemplateDto, LabelsContext } from '../application/labels.types';
import {
  createLabelQrTemplateSchema,
  deleteLabelQrTemplateSchema,
  updateLabelQrTemplateSchema,
} from '../dto/label-qr-template.dto';
import { assertLabelsEnabled, requireUser } from './label-fields.controller';
import { parse, parseId } from './label-templates.controller';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('label-qr-templates')
export class LabelQrTemplatesController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listLabelQrTemplates', summary: 'List label QR templates' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser, @Query('includeInactive') includeInactive?: string): Promise<LabelQrTemplateDto[]> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.listQrTemplates({ ...this.context(request), includeInactive: includeInactive === 'true' });
  }

  @ApiOperation({ operationId: 'createLabelQrTemplate', summary: 'Create label QR template' })
  @Post()
  @HttpCode(200)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<LabelQrTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.createQrTemplate({ ...this.context(request), input: parse(createLabelQrTemplateSchema, body) });
  }

  @ApiOperation({ operationId: 'updateLabelQrTemplate', summary: 'Update label QR template' })
  @Put(':id')
  async update(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<LabelQrTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    const { version, ...input } = parse(updateLabelQrTemplateSchema, body);
    return this.service.updateQrTemplate({ ...this.context(request), id: parseId(id), expectedVersion: version, input });
  }

  @ApiOperation({ operationId: 'deleteLabelQrTemplate', summary: 'Delete label QR template' })
  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    assertLabelsEnabled(this.runtimeConfig);
    const parsed = parse(deleteLabelQrTemplateSchema, body);
    await this.service.deleteQrTemplate({ ...this.context(request), id: parseId(id), expectedVersion: parsed.version, idempotencyKey: parsed.idempotencyKey });
  }

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}
