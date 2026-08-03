import { Controller, Get, Headers, Param, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { OrderRealtimeSnapshotService } from '../application/order-realtime-snapshot.service';
import { OrderRealtimeStreamService } from '../application/order-realtime-stream.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrderRealtimeController {
  constructor(
    private readonly snapshots: OrderRealtimeSnapshotService,
    private readonly streams: OrderRealtimeStreamService,
  ) {}

  @ApiOperation({
    operationId: 'getOrderDetailLiveState',
    summary: 'Read the compact authoritative live state for order detail cells',
  })
  @ApiParam({ name: 'orderId', type: Number })
  @ApiResponse({ status: 200, description: 'Compact detail live-state snapshot' })
  @ApiResponse({ status: 304, description: 'Live-state representation is unchanged' })
  @Get(':orderId/detail-live-state')
  async detailLiveState(
    @Req() request: RequestWithCurrentUser,
    @Res() response: Response,
    @Param('orderId') orderIdParam: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    const snapshot = await this.snapshots.getSnapshot({
      tokenUser: requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
    });

    response.setHeader('Cache-Control', 'private, no-cache, no-transform');
    response.setHeader('Vary', 'Authorization, Origin');
    response.setHeader('ETag', snapshot.etag);
    response.setHeader('X-ERP-Stream-Cursor', snapshot.streamCursor);
    response.setHeader('X-ERP-Realtime-Enabled', String(snapshot.streamEnabled));

    if (ifNoneMatch === snapshot.etag) {
      response.status(304).end();
      return;
    }

    const { etag: _etag, ...body } = snapshot;
    response.status(200).json(body);
  }

  @ApiOperation({
    operationId: 'streamOrderLiveEvents',
    summary: 'Stream permission-filtered order live-state invalidations',
  })
  @ApiParam({ name: 'orderId', type: Number })
  @ApiResponse({ status: 200, description: 'SSE stream' })
  @ApiResponse({ status: 204, description: 'Realtime rollout is disabled for this user' })
  @ApiResponse({ status: 429, description: 'Realtime connection limit reached' })
  @Get(':orderId/live-events')
  async liveEvents(
    @Req() request: RequestWithCurrentUser,
    @Res() response: Response,
    @Param('orderId') orderIdParam: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    const result = await this.streams.open({
      tokenUser: requireCurrentUser(request),
      accessTokenExpiresAt: request.accessTokenExpiresAt,
      orderId: parseOrderId(orderIdParam),
      lastEventId,
      response,
    });
    if (result === 'disabled') {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-ERP-Realtime-Enabled', 'false');
      response.status(204).end();
      return;
    }
    if (result === 'limited') {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Retry-After', '5');
      response.status(429).json({
        error: { code: 'ORDER_REALTIME_CONNECTION_LIMIT', message: 'Realtime connection limit reached' },
      });
    }
  }
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  return request.user;
}

function parseOrderId(value: string): number {
  const orderId = Number(value);
  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'orderId must be a positive integer');
  }
  return orderId;
}
