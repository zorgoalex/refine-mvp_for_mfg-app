import {
  Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Req,
  Res, StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { BazisCutService } from '../application/bazis-cut.service';
import {
  addBazisCutSetDetailsSchema,
  createBazisCutSetSchema,
  deleteBazisCutSetDetailSchema,
  listBazisCutSetsSchema,
  renameBazisCutSetSchema,
  updateBazisCutSetDetailSchema,
} from '../dto/bazis-cut.dto';
import { BazisCutRuntimeConfigService } from './bazis-cut-runtime-config.service';

const positiveId = z.coerce.number().int().positive();
const idParameter = { name: 'setId', type: Number, required: true } as const;
const commandHeader = { name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 } } as const;
const detailFieldNames = [
  'cutEnabled', 'materialType', 'materialName', 'materialArticle', 'thicknessMm', 'position', 'partName',
  'finishedLengthMm', 'finishedWidthMm', 'cutLengthMm', 'cutWidthMm', 'quantity', 'orientation', 'groove',
  'l1Name', 'l1Designation', 'l1ThicknessMm', 'l2Name', 'l2Designation', 'l2ThicknessMm',
  'w1Name', 'w1Designation', 'w1ThicknessMm', 'w2Name', 'w2Designation', 'w2ThicknessMm',
  'priority', 'comment', 'customProperty', 'glue', 'milling', 'route', 'film',
];
const textProperty = (maxLength: number): SchemaObject => ({ type: 'string', maxLength });
const positiveMm: SchemaObject = { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 99_999_999.99 };
const edgeMm: SchemaObject = { type: 'number', minimum: 0, maximum: 99_999_999.99 };
const detailProperties: NonNullable<SchemaObject['properties']> = {
  cutEnabled: { type: 'boolean' }, materialType: { type: 'string', minLength: 1, maxLength: 100 },
  materialName: { type: 'string', minLength: 1, maxLength: 200 }, materialArticle: textProperty(200),
  thicknessMm: positiveMm, position: { type: 'string' },
  partName: { type: 'string', minLength: 1, maxLength: 300 }, finishedLengthMm: positiveMm,
  finishedWidthMm: positiveMm, cutLengthMm: positiveMm, cutWidthMm: positiveMm,
  quantity: { type: 'integer', minimum: 1, maximum: 1_000_000 }, orientation: textProperty(50), groove: textProperty(500),
  l1Name: textProperty(200), l1Designation: textProperty(200), l1ThicknessMm: edgeMm,
  l2Name: textProperty(200), l2Designation: textProperty(200), l2ThicknessMm: edgeMm,
  w1Name: textProperty(200), w1Designation: textProperty(200), w1ThicknessMm: edgeMm,
  w2Name: textProperty(200), w2Designation: textProperty(200), w2ThicknessMm: edgeMm,
  priority: { type: 'integer', minimum: 0, maximum: 1_000_000, nullable: true },
  comment: textProperty(2000), customProperty: textProperty(2000), glue: textProperty(500),
  milling: textProperty(200), route: textProperty(500), film: textProperty(200),
};
const updateDetailSchema: SchemaObject = { type: 'object', additionalProperties: false,
  required: [...detailFieldNames, 'expectedVersion'],
  properties: { ...detailProperties, expectedVersion: { type: 'integer', minimum: 0 } } };
const sourceRefSchema: SchemaObject = { type: 'object', required: ['id', 'label'], properties: {
  id: { type: 'integer', format: 'int64' }, label: { type: 'string' },
  deleted: { type: 'boolean' },
} };
const sourceRefs = (): SchemaObject => ({ type: 'array', items: sourceRefSchema });
const summaryProperties: NonNullable<SchemaObject['properties']> = {
  bazisCutSetId: { type: 'integer', format: 'int64' }, name: { type: 'string' },
  version: { type: 'integer', minimum: 0 }, createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' }, quantity: { type: 'integer', minimum: 0 },
  positionCount: { type: 'integer', minimum: 0 }, orders: sourceRefs(), projects: sourceRefs(),
  bazisProjects: sourceRefs(), bazisOrders: sourceRefs(),
};
const summaryRequired = Object.keys(summaryProperties);
const detailResponseSchema: SchemaObject = { type: 'object', additionalProperties: false,
  required: [...detailFieldNames, 'bazisCutSetDetailId', 'bazisCutSetId', 'sortOrder', 'sourceOrderDetailId',
    'sourceOrderId', 'sourceProjectId', 'sourceBazisProjectId', 'sourceBazisRevisionId', 'sourceBazisNodeId',
    'sourceOrderDeleted', 'sourceOrderName', 'sourceOrderFullNumber', 'sourceProjectCode', 'sourceBazisProjectName', 'sourceBazisOrderNo',
    'sourceBazisProductName', 'sourceBathCutNumber',
    'createdAt', 'updatedAt'],
  properties: { ...detailProperties,
    bazisCutSetDetailId: { type: 'integer', format: 'int64' }, bazisCutSetId: { type: 'integer', format: 'int64' },
    sortOrder: { type: 'integer', minimum: 0 },
    sourceOrderDetailId: { type: 'integer', format: 'int64', nullable: true },
    sourceOrderId: { type: 'integer', format: 'int64', nullable: true },
    sourceOrderDeleted: { type: 'boolean' },
    sourceProjectId: { type: 'integer', format: 'int64', nullable: true },
    sourceBazisProjectId: { type: 'integer', format: 'int64', nullable: true },
    sourceBazisRevisionId: { type: 'integer', format: 'int64', nullable: true },
    sourceBazisNodeId: { type: 'integer', format: 'int64', nullable: true },
    sourceOrderName: { type: 'string' }, sourceOrderFullNumber: { type: 'string' }, sourceProjectCode: { type: 'string' },
    sourceBazisProjectName: { type: 'string' }, sourceBazisOrderNo: { type: 'string' },
    sourceBazisProductName: { type: 'string' }, sourceBathCutNumber: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  } };
const setResponseSchema: SchemaObject = { type: 'object', additionalProperties: false,
  required: [...summaryRequired, 'createdBy', 'updatedBy', 'details'], properties: { ...summaryProperties,
    createdBy: { type: 'integer', format: 'int64', nullable: true },
    updatedBy: { type: 'integer', format: 'int64', nullable: true },
    details: { type: 'array', items: detailResponseSchema },
  } };
const mutationResponseSchema: SchemaObject = { type: 'object', required: ['set'], properties: {
  set: setResponseSchema, addedCount: { type: 'integer', minimum: 0 },
} };

@ApiTags('BazisCutSets')
@ApiBearerAuth()
@Controller('bazis-cut-sets')
export class BazisCutSetsController {
  constructor(
    @Inject(BazisCutService) private readonly service: BazisCutService,
    @Inject(BazisCutRuntimeConfigService) private readonly runtime: BazisCutRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listBazisCutSets', summary: 'List persistent Basis-cut export sets' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, schema: { minimum: 1, default: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, schema: { minimum: 1, maximum: 100, default: 25 } })
  @ApiResponse({ status: 200, description: 'Paginated saved sets', schema: { type: 'object',
    required: ['items', 'page', 'pageSize', 'total'], properties: {
      items: { type: 'array', items: { type: 'object', required: summaryRequired, properties: summaryProperties } },
      page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1 },
      total: { type: 'integer', minimum: 0 },
    } } })
  @Get()
  list(@Req() request: RequestWithCurrentUser, @Query() query: unknown) {
    this.assertEnabled();
    const parsed = parse(listBazisCutSetsSchema, query);
    return this.service.list({ currentUser: requireUser(request), requestId: request.requestId, ...parsed });
  }

  @ApiOperation({ operationId: 'createBazisCutSet', summary: 'Create a Basis-cut set from order details' })
  @ApiHeader(commandHeader)
  @ApiBody({ schema: { type: 'object', required: ['orderId', 'detailIds'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 }, orderId: { type: 'integer', minimum: 1 },
    detailIds: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'integer', minimum: 1 } },
  } } })
  @ApiResponse({ status: 201, description: 'Persistent set and snapshot details', schema: mutationResponseSchema })
  @Post()
  create(@Req() request: RequestWithCurrentUser, @Headers('idempotency-key') key: string | string[] | undefined,
    @Body() body: unknown) {
    this.assertEnabled();
    const parsed = parse(createBazisCutSetSchema, body);
    return this.service.create({ currentUser: requireUser(request), requestId: request.requestId,
      idempotencyKey: parseIdempotencyKey(key), ...parsed });
  }

  @ApiOperation({ operationId: 'getBazisCutSet', summary: 'Get a Basis-cut set card' })
  @ApiParam(idParameter)
  @ApiResponse({ status: 200, description: 'Set card with typed snapshots', schema: setResponseSchema })
  @Get(':setId')
  get(@Req() request: RequestWithCurrentUser, @Param('setId') setId: string) {
    this.assertEnabled();
    return this.service.get({ currentUser: requireUser(request), requestId: request.requestId, setId: parseId(setId) });
  }

  @ApiOperation({ operationId: 'renameBazisCutSet', summary: 'Rename a Basis-cut set' })
  @ApiParam(idParameter)
  @ApiHeader(commandHeader)
  @ApiBody({ schema: { type: 'object', required: ['name', 'expectedVersion'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 }, expectedVersion: { type: 'integer', minimum: 0 },
  } } })
  @ApiResponse({ status: 200, description: 'Renamed set', schema: mutationResponseSchema })
  @Patch(':setId')
  rename(@Req() request: RequestWithCurrentUser, @Param('setId') setId: string,
    @Headers('idempotency-key') key: string | string[] | undefined, @Body() body: unknown) {
    this.assertEnabled();
    const parsed = parse(renameBazisCutSetSchema, body);
    return this.service.rename({ currentUser: requireUser(request), requestId: request.requestId,
      setId: parseId(setId), idempotencyKey: parseIdempotencyKey(key), ...parsed });
  }

  @ApiOperation({ operationId: 'addBazisCutSetDetails', summary: 'Add order details to a Basis-cut set' })
  @ApiParam(idParameter)
  @ApiHeader(commandHeader)
  @ApiBody({ schema: { type: 'object', required: ['orderId', 'detailIds', 'expectedVersion'], properties: {
    orderId: { type: 'integer', minimum: 1 }, expectedVersion: { type: 'integer', minimum: 0 },
    detailIds: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'integer', minimum: 1 } },
  } } })
  @ApiResponse({ status: 201, description: 'Updated set', schema: mutationResponseSchema })
  @Post(':setId/details')
  addDetails(@Req() request: RequestWithCurrentUser, @Param('setId') setId: string,
    @Headers('idempotency-key') key: string | string[] | undefined, @Body() body: unknown) {
    this.assertEnabled();
    const parsed = parse(addBazisCutSetDetailsSchema, body);
    return this.service.addDetails({ currentUser: requireUser(request), requestId: request.requestId,
      setId: parseId(setId), idempotencyKey: parseIdempotencyKey(key), ...parsed });
  }

  @ApiOperation({ operationId: 'updateBazisCutSetDetail', summary: 'Replace all 33 editable Basis fields of a set detail' })
  @ApiParam(idParameter)
  @ApiParam({ name: 'detailId', type: Number, required: true })
  @ApiHeader(commandHeader)
  @ApiBody({ description: 'Strict full replacement: all 33 editable Basis fields plus expectedVersion', schema: updateDetailSchema })
  @ApiResponse({ status: 200, description: 'Updated set', schema: mutationResponseSchema })
  @Patch(':setId/details/:detailId')
  updateDetail(@Req() request: RequestWithCurrentUser, @Param('setId') setId: string,
    @Param('detailId') detailId: string, @Headers('idempotency-key') key: string | string[] | undefined,
    @Body() body: unknown) {
    this.assertEnabled();
    const parsed = parse(updateBazisCutSetDetailSchema, body);
    const { expectedVersion, ...fields } = parsed;
    return this.service.updateDetail({ currentUser: requireUser(request), requestId: request.requestId,
      setId: parseId(setId), detailId: parseId(detailId), expectedVersion, fields,
      idempotencyKey: parseIdempotencyKey(key) });
  }

  @ApiOperation({ operationId: 'deleteBazisCutSetDetail', summary: 'Delete a detail from a Basis-cut set' })
  @ApiParam(idParameter)
  @ApiParam({ name: 'detailId', type: Number, required: true })
  @ApiHeader(commandHeader)
  @ApiBody({ schema: { type: 'object', required: ['expectedVersion'], properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
  } } })
  @ApiResponse({ status: 200, description: 'Updated set', schema: mutationResponseSchema })
  @Delete(':setId/details/:detailId')
  deleteDetail(@Req() request: RequestWithCurrentUser, @Param('setId') setId: string,
    @Param('detailId') detailId: string, @Headers('idempotency-key') key: string | string[] | undefined,
    @Body() body: unknown) {
    this.assertEnabled();
    const parsed = parse(deleteBazisCutSetDetailSchema, body);
    return this.service.deleteDetail({ currentUser: requireUser(request), requestId: request.requestId,
      setId: parseId(setId), detailId: parseId(detailId), idempotencyKey: parseIdempotencyKey(key), ...parsed });
  }

  @ApiOperation({ operationId: 'exportBazisCutSetXls', summary: 'Export a saved set as BIFF8 XLS' })
  @ApiParam(idParameter)
  @ApiProduces('application/vnd.ms-excel')
  @ApiResponse({ status: 201, description: 'BIFF8 XLS', schema: { type: 'string', format: 'binary' } })
  @Post(':setId/export.xls')
  async export(@Req() request: RequestWithCurrentUser, @Param('setId') setId: string,
    @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    this.assertEnabled();
    const result = await this.service.export({ currentUser: requireUser(request), requestId: request.requestId,
      setId: parseId(setId) });
    const filename = buildFilename(result.set.name, result.set.bazisCutSetId);
    response.setHeader('Content-Type', 'application/vnd.ms-excel');
    response.setHeader('Content-Disposition', contentDisposition(filename));
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(result.bytes);
  }

  private assertEnabled(): void {
    if (!this.runtime.isEnabled()) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Bazis-cut API is disabled', { feature: 'bazisCut' });
    }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(422, 'VALIDATION_ERROR', 'Bazis-cut payload validation failed', {
    errors: result.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
  });
}

function requireUser(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function parseId(value: string): number { return parse(positiveId, value); }

function parseIdempotencyKey(value: string | string[] | undefined): string {
  const key = (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  if (key.length < 8 || key.length > 200) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key header is required (8..200 chars)', {
      errors: [{ field: 'Idempotency-Key', message: 'Length must be between 8 and 200' }],
    });
  }
  return key;
}

function buildFilename(name: string, id: number): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '').slice(0, 120) || 'набор';
  return `Базис-раскрой-${safe}-${id}.xls`;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
