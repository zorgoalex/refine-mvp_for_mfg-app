import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { sniffImageMime } from '../application/scan/image-mime-sniffer';
import { LabelsService, type PreviewOcrLabelResult, type TestOcrTemplateResult } from '../application/labels.service';
import type { LabelOcrTemplateDto, LabelsContext } from '../application/labels.types';
import {
  createLabelOcrTemplateSchema,
  deleteLabelOcrTemplateSchema,
  testOcrRulesSchema,
  updateLabelOcrTemplateSchema,
} from '../dto/label-ocr-template.dto';
import { assertLabelsEnabled, requireUser } from './label-fields.controller';
import { parse, parseId } from './label-templates.controller';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

const MAX_OCR_TEMPLATE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Duck-typed multer file shape (mirrors label-scan.controller.ts's own uploaded-file
 *  handling — no @types/multer dependency in this codebase). */
interface UploadedImageFile {
  buffer?: Buffer;
  size?: number;
}

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('label-ocr-templates')
export class LabelOcrTemplatesController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listLabelOcrTemplates', summary: 'List label OCR templates' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<LabelOcrTemplateDto[]> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.listOcrTemplates({ ...this.context(request), includeInactive: includeInactive === 'true' });
  }

  @ApiOperation({ operationId: 'createLabelOcrTemplate', summary: 'Create label OCR template' })
  @Post()
  @HttpCode(200)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<LabelOcrTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.createOcrTemplate({ ...this.context(request), input: parse(createLabelOcrTemplateSchema, body) });
  }

  @ApiOperation({ operationId: 'updateLabelOcrTemplate', summary: 'Update label OCR template' })
  @Put(':id')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LabelOcrTemplateDto> {
    assertLabelsEnabled(this.runtimeConfig);
    const { version, ...input } = parse(updateLabelOcrTemplateSchema, body);
    return this.service.updateOcrTemplate({
      ...this.context(request),
      id: parseId(id),
      expectedVersion: version,
      input,
    });
  }

  @ApiOperation({ operationId: 'deleteLabelOcrTemplate', summary: 'Delete label OCR template' })
  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    assertLabelsEnabled(this.runtimeConfig);
    const parsed = parse(deleteLabelOcrTemplateSchema, body);
    await this.service.deleteOcrTemplate({
      ...this.context(request),
      id: parseId(id),
      expectedVersion: parsed.version,
      idempotencyKey: parsed.idempotencyKey,
    });
  }

  @ApiOperation({
    operationId: 'previewLabelOcrTemplate',
    summary: 'Run OCR recognition on a photo for the template-config UI (no matching, no audit)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'Photo of a printed label.' } },
    },
  })
  @ApiResponse({ status: 415, description: 'Uploaded file is not a recognizable image' })
  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OCR_TEMPLATE_IMAGE_BYTES } }))
  async preview(
    @Req() request: RequestWithCurrentUser,
    @UploadedFile() uploadedFile: unknown,
  ): Promise<PreviewOcrLabelResult> {
    assertLabelsEnabled(this.runtimeConfig);
    const file = uploadedFile as UploadedImageFile | undefined;
    if (!file?.buffer || file.buffer.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Label image file is required', {
        errors: [{ field: 'file', message: 'file is required' }],
      });
    }
    // Never trust the client-supplied mimetype/Content-Type — sniff the actual bytes
    // (mirrors label-scan.controller.ts's scanResolveImage guard).
    const contentType = sniffImageMime(file.buffer);
    if (!contentType) {
      throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Unsupported image type', {});
    }
    return this.service.previewOcrLabel({
      ...this.context(request),
      image: file.buffer,
      contentType,
    });
  }

  @ApiOperation({
    operationId: 'testLabelOcrTemplate',
    summary: 'Dry-run a candidate OCR rule set against a photo for the template-config UI',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'rules'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Photo of a printed label.' },
        rules: { type: 'string', description: 'JSON-encoded array of candidate OCR rules.' },
      },
    },
  })
  @ApiResponse({ status: 415, description: 'Uploaded file is not a recognizable image' })
  @Post('test')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OCR_TEMPLATE_IMAGE_BYTES } }))
  async test(
    @Req() request: RequestWithCurrentUser,
    @UploadedFile() uploadedFile: unknown,
    @Body('rules') rulesField: unknown,
  ): Promise<TestOcrTemplateResult> {
    assertLabelsEnabled(this.runtimeConfig);
    const file = uploadedFile as UploadedImageFile | undefined;
    if (!file?.buffer || file.buffer.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Label image file is required', {
        errors: [{ field: 'file', message: 'file is required' }],
      });
    }
    const contentType = sniffImageMime(file.buffer);
    if (!contentType) {
      throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Unsupported image type', {});
    }
    const rules = parse(testOcrRulesSchema, parseRulesJson(rulesField));
    return this.service.testOcrTemplate({
      ...this.context(request),
      image: file.buffer,
      contentType,
      rules,
    });
  }

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}

/** The `test` route carries the candidate rule set as a JSON-encoded string multipart
 *  field (multipart/form-data has no native array/object field type). Malformed JSON is a
 *  client error, not a server error — surface it the same way schema validation failures
 *  are surfaced elsewhere in this module (400 BAD_REQUEST). */
function parseRulesJson(rulesField: unknown): unknown {
  if (typeof rulesField !== 'string' || rulesField.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'rules field is required', { field: 'rules' });
  }
  try {
    return JSON.parse(rulesField);
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'rules field must be valid JSON', { field: 'rules' });
  }
}
