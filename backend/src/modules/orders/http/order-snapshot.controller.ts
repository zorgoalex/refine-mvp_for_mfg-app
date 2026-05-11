import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
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

@Controller('orders')
export class OrderSnapshotController {
  constructor(
    @Inject(OrderSnapshotService)
    private readonly snapshots: OrderSnapshotService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
  ) {}

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
