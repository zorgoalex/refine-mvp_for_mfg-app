import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderSnapshotService } from '../application/order-snapshot.service';
import type {
  ImportOrderSnapshotBatchRequestDto,
  ImportOrderSnapshotRequestDto,
} from '../dto/order-snapshot.dto';
import { parseOrderId } from './orders.controller';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const dateOnlySwaggerSchema = { type: 'string', format: 'date' } as const;

const snapshotIdentitySwaggerSchema = {
  type: 'object',
  required: ['sourceId', 'refKey1c'],
  properties: {
    sourceId: { type: 'string' },
    refKey1c: { type: 'string', nullable: true },
  },
} as const;

const orderSnapshotSwaggerSchema = {
  type: 'object',
  required: ['schema', 'formatVersion', 'exporterService', 'source', 'identity', 'data', 'references'],
  properties: {
    schema: { type: 'string', enum: ['erp.order.snapshot.v1'] },
    formatVersion: { type: 'string' },
    exporterService: {
      type: 'object',
      required: ['name', 'version', 'compatibleImportVersions'],
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        compatibleImportVersions: { type: 'array', items: { type: 'string' } },
      },
    },
    source: {
      type: 'object',
      required: ['sourceInstanceId', 'exportedAt', 'payloadHash'],
      properties: {
        sourceInstanceId: { type: 'string' },
        exportedAt: { type: 'string', format: 'date-time' },
        payloadHash: { type: 'string' },
      },
    },
    identity: {
      type: 'object',
      required: ['order', 'client'],
      properties: {
        order: snapshotIdentitySwaggerSchema,
        client: snapshotIdentitySwaggerSchema,
      },
    },
    data: {
      type: 'object',
      additionalProperties: true,
    },
    references: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } } },
  },
} as const;

const importOrderSnapshotRequestSwaggerSchema = {
  type: 'object',
  required: ['snapshot'],
  properties: {
    snapshot: orderSnapshotSwaggerSchema,
  },
} as const;

const importOrderSnapshotBatchRequestSwaggerSchema = {
  type: 'object',
  required: ['zipBase64'],
  properties: {
    fileName: { type: 'string' },
    zipBase64: { type: 'string', format: 'byte' },
  },
} as const;

const orderSnapshotImportSummarySwaggerSchema = {
  type: 'object',
  required: ['details', 'payments', 'workshops', 'requirements', 'dowelingLinks', 'productionStatusEvents', 'clientPhones', 'deadlineInstances', 'deadlineEvents'],
  properties: {
    details: { type: 'integer' },
    payments: { type: 'integer' },
    workshops: { type: 'integer' },
    requirements: { type: 'integer' },
    dowelingLinks: { type: 'integer' },
    productionStatusEvents: { type: 'integer' },
    clientPhones: { type: 'integer' },
    deadlineInstances: { type: 'integer' },
    deadlineEvents: { type: 'integer' },
  },
} as const;

const orderSnapshotImportResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'status', 'orderId', 'orderName', 'payloadHash', 'importRunId', 'summary'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    status: { type: 'string', enum: ['created', 'updated', 'noop'] },
    orderId: { type: 'integer' },
    orderName: { type: 'string' },
    payloadHash: { type: 'string' },
    importRunId: { type: 'string', nullable: true },
    summary: orderSnapshotImportSummarySwaggerSchema,
  },
} as const;

const orderSnapshotImportBatchResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'total', 'imported', 'failed', 'results'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    total: { type: 'integer' },
    imported: { type: 'integer' },
    failed: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        oneOf: [
          {
            allOf: [
              orderSnapshotImportResponseSwaggerSchema,
              { type: 'object', required: ['fileName'], properties: { fileName: { type: 'string' } } },
            ],
          },
          {
            type: 'object',
            required: ['fileName', 'success', 'errorCode', 'message'],
            properties: {
              fileName: { type: 'string' },
              success: { type: 'boolean', enum: [false] },
              errorCode: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
            },
          },
        ],
      },
    },
  },
} as const;

@ApiTags('Order Snapshots')
@ApiBearerAuth()
@Controller('orders')
export class OrderSnapshotController {
  constructor(
    @Inject(OrderSnapshotService)
    private readonly snapshots: OrderSnapshotService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiResponse({
    status: 200,
    description: 'Order snapshot JSON file',
    content: {
      'application/json': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'exportOrderSnapshot', summary: 'Export an order snapshot' })
  @Get(':orderId/snapshot')
  async exportOne(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertOrdersEnabled();
    const currentUser = this.requireCurrentUser(request);
    const orderId = parseOrderId(orderIdParam);
    const file = await this.snapshots.exportOrderSnapshot({
      currentUser,
      orderId,
      requestId: request.requestId,
    });

    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', contentDisposition(file.fileName));
    response.send(file.content);
  }

  @ApiQuery({ name: 'dateFrom', required: true, type: String, description: 'Start date', schema: swaggerSchema(dateOnlySwaggerSchema) })
  @ApiQuery({ name: 'dateTo', required: true, type: String, description: 'End date', schema: swaggerSchema(dateOnlySwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'ZIP archive containing order snapshot JSON files',
    headers: {
      'X-Order-Snapshot-Count': {
        description: 'Number of snapshots included in the archive',
        schema: { type: 'integer', minimum: 0 },
      },
    },
    content: {
      'application/zip': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid snapshot batch query' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'exportOrderSnapshotBatch', summary: 'Export a batch of order snapshots' })
  @Get('snapshot/batch')
  async exportBatch(
    @Req() request: RequestWithCurrentUser,
    @Res() response: Response,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
  ): Promise<void> {
    this.assertOrdersEnabled();
    const currentUser = this.requireCurrentUser(request);
    const from = requireDateQuery(dateFrom, 'dateFrom');
    const to = requireDateQuery(dateTo, 'dateTo');
    const file = await this.snapshots.exportOrderSnapshotBatch({
      currentUser,
      dateFrom: from,
      dateTo: to,
      requestId: request.requestId,
    });

    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', contentDisposition(file.fileName));
    response.setHeader('X-Order-Snapshot-Count', String(file.orderCount));
    response.send(file.content);
  }

  @ApiBody({ schema: swaggerSchema(importOrderSnapshotRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Imported order snapshot', schema: swaggerSchema(orderSnapshotImportResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid snapshot import payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'importOrderSnapshot', summary: 'Import an order snapshot' })
  @Post('snapshot/import')
  @HttpCode(200)
  async importOne(
    @Req() request: RequestWithCurrentUser,
    @Body() body: ImportOrderSnapshotRequestDto,
  ) {
    this.assertOrdersWriteEnabled();
    const currentUser = this.requireCurrentUser(request);
    if (!body.snapshot) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'snapshot is required');
    }

    return this.snapshots.importOrderSnapshot({
      currentUser,
      snapshot: body.snapshot,
      requestId: request.requestId,
    });
  }

  @ApiBody({ schema: swaggerSchema(importOrderSnapshotBatchRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Imported order snapshot batch', schema: swaggerSchema(orderSnapshotImportBatchResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid snapshot batch import payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'importOrderSnapshotBatch', summary: 'Import an order snapshot batch' })
  @Post('snapshot/import-batch')
  @HttpCode(200)
  async importBatch(
    @Req() request: RequestWithCurrentUser,
    @Body() body: ImportOrderSnapshotBatchRequestDto,
  ) {
    this.assertOrdersWriteEnabled();
    const currentUser = this.requireCurrentUser(request);
    if (!body.zipBase64) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'zipBase64 is required');
    }

    return this.snapshots.importOrderSnapshotBatch({
      currentUser,
      zipBase64: body.zipBase64,
      requestId: request.requestId,
    });
  }

  private assertOrdersEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
  }

  private assertOrdersWriteEnabled(): void {
    this.assertOrdersEnabled();
    const flags = this.runtimeConfig.getFeatureFlags();
    if (flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders write API is disabled', {
        feature: 'orders',
        mode: 'read_only',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

function requireDateQuery(value: string | undefined, field: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must use YYYY-MM-DD format`);
  }

  return value;
}

function contentDisposition(fileName: string): string {
  return `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
