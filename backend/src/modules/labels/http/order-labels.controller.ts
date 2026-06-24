import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { LabelsService } from '../application/labels.service';
import type {
  LabelsContext,
  LatestOrderLabelsPreviewDto,
  OrderLabelDataDto,
  OrderLabelGenerationDto,
  OrderLabelsPreviewDto,
} from '../application/labels.types';
import { generateOrderLabelsSchema, previewOrderLabelsSchema, updateOrderLabelDataSchema } from '../dto/order-label.dto';
import { assertLabelsEnabled, requireUser } from './label-fields.controller';
import { parseId } from './label-templates.controller';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('orders/:orderId/label-data')
export class OrderLabelsController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'getOrderLabelData', summary: 'Get order label data' })
  @Get()
  async getLabelData(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Query('templateId') templateId: string | undefined,
  ): Promise<OrderLabelDataDto> {
    assertLabelsEnabled(this.runtimeConfig);
    if (!templateId) {
      throw new ApiError(400, 'BAD_REQUEST', 'templateId is required', { field: 'templateId' });
    }
    return this.service.getOrderLabelData({
      ...this.context(request),
      orderId: parseId(orderId),
      templateId: parseId(templateId),
    });
  }

  @ApiOperation({ operationId: 'updateOrderLabelData', summary: 'Update order label data' })
  @Put()
  @HttpCode(200)
  async updateLabelData(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<OrderLabelDataDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.updateOrderLabelData({
      ...this.context(request),
      orderId: parseId(orderId),
      input: parse(updateOrderLabelDataSchema, body),
    });
  }

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('orders/:orderId/labels')
export class OrderLabelActionsController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'previewOrderLabels', summary: 'Preview order labels' })
  @Post('preview')
  @HttpCode(200)
  async preview(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<OrderLabelsPreviewDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.previewOrderLabels({
      ...this.context(request),
      orderId: parseId(orderId),
      input: parse(previewOrderLabelsSchema, body),
    });
  }

  @ApiOperation({ operationId: 'generateOrderLabels', summary: 'Generate order labels' })
  @Post('generate')
  @HttpCode(200)
  async generate(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ): Promise<OrderLabelGenerationDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.generateOrderLabels({
      ...this.context(request),
      orderId: parseId(orderId),
      input: parse(generateOrderLabelsSchema, body),
    });
  }

  @ApiOperation({ operationId: 'getLatestOrderLabels', summary: 'Get latest order labels preview' })
  @Get('latest')
  async latest(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
  ): Promise<LatestOrderLabelsPreviewDto> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.getLatestOrderLabelsPreview({ ...this.context(request), orderId: parseId(orderId) });
  }

  @ApiOperation({ operationId: 'exportLatestOrderLabels', summary: 'Export latest order labels' })
  @Get('latest/export')
  @Header('Content-Type', 'application/zip')
  async exportLatest(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    assertLabelsEnabled(this.runtimeConfig);
    const result = await this.service.exportOrderLabels({ ...this.context(request), orderId: parseId(orderId) });
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return new StreamableFile(result.body, { type: result.contentType });
  }

  @ApiOperation({ operationId: 'exportOrderLabelGeneration', summary: 'Export a specific order label generation' })
  @Get('generations/:generationId/export')
  @Header('Content-Type', 'application/zip')
  async exportGeneration(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Param('generationId') generationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    assertLabelsEnabled(this.runtimeConfig);
    const result = await this.service.exportOrderLabels({
      ...this.context(request),
      orderId: parseId(orderId),
      generationId: parseId(generationId),
    });
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return new StreamableFile(result.body, { type: result.contentType });
  }

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Label payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  return parsed.data;
}
