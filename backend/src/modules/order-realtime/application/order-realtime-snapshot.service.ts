import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOrderRealtimeReader } from '../adapters/pg-order-realtime-reader';
import { formatOrderRealtimeCursor } from './order-realtime-cursor';
import type { OrderDetailLiveSnapshot } from './order-realtime-read.types';
import { OrderRealtimeRuntimeConfigService } from './order-realtime-runtime-config.service';

@Injectable()
export class OrderRealtimeSnapshotService {
  constructor(
    private readonly reader: PgOrderRealtimeReader,
    private readonly runtimeConfig: OrderRealtimeRuntimeConfigService,
  ) {}

  async getSnapshot(input: {
    tokenUser: CurrentUser;
    orderId: number;
  }): Promise<OrderDetailLiveSnapshot> {
    if (!this.runtimeConfig.snapshotEnabled) {
      throw new ApiError(503, 'ORDER_LIVE_SNAPSHOT_DISABLED', 'Order live snapshot is disabled');
    }

    const authorization = await this.reader.authorize(input);
    const [state, streamEnabled] = await Promise.all([
      this.reader.loadSnapshot(input.orderId, authorization.cutRefsAllowed),
      this.runtimeConfig.isStreamEnabledForUser(authorization.currentUser.id),
    ]);
    const streamCursor = formatOrderRealtimeCursor({
      schemaVersion: 1,
      detailStatusRevision: state.detailStatusRevision,
      ...(authorization.cutRefsAllowed ? { cutRefsRevision: state.cutRefsRevision } : {}),
    });
    const cutRefsAccess = authorization.cutRefsAllowed ? 'allowed' : 'denied';
    const etag = createSnapshotEtag({
      orderId: input.orderId,
      streamEnabled,
      cutRefsAccess,
      permissionVariant: authorization.permissionVariant,
      details: state.details,
    });

    return {
      orderId: input.orderId,
      streamEnabled,
      streamCursor,
      cutRefsAccess,
      details: state.details,
      etag,
    };
  }
}

function createSnapshotEtag(value: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('base64url');
  return `"order-live-${digest}"`;
}
