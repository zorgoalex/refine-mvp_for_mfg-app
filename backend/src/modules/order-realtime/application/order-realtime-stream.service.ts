import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';
import type { Notification, PoolClient, QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { HealthCheckStatus } from '../../health/health.contract';
import { PgOrderRealtimeReader } from '../adapters/pg-order-realtime-reader';
import { formatOrderRealtimeCursor, parseOrderRealtimeCursor } from './order-realtime-cursor';
import type { AuthorizedOrderRealtimeContext } from './order-realtime-read.types';
import type { OrderRealtimeCursor, OrderRealtimeEventRecord } from './order-realtime.types';
import { OrderRealtimeRuntimeConfigService } from './order-realtime-runtime-config.service';

interface StreamWatermarkRow extends QueryResultRow {
  order_id: string | number;
  commit_sequence: string | number;
}

interface Subscriber {
  id: number;
  orderId: number;
  tokenUser: CurrentUser;
  accessTokenExpiresAt: Date;
  authorization: AuthorizedOrderRealtimeContext;
  response: Response;
  deliveredCursor: OrderRealtimeCursor;
  scannedCommitSequence: number;
  initializing: boolean;
  pendingWakeCount: number;
  drain: Promise<void>;
  expiryTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export type OpenOrderRealtimeStreamResult = 'opened' | 'disabled' | 'limited';

@Injectable()
export class OrderRealtimeStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderRealtimeStreamService.name);
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly orderHighWatermarks = new Map<number, number>();
  private nextSubscriberId = 1;
  private listenerClient: PoolClient | null = null;
  private listenerGeneration = 0;
  private listenerRetryTimer: NodeJS.Timeout | null = null;
  private catchupTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private catchupRunning = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly reader: PgOrderRealtimeReader,
    private readonly runtimeConfig: OrderRealtimeRuntimeConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeConfig.streamTransportEnabled || !this.database.isConfigured) return;
    void this.connectListener();
    this.catchupTimer = setInterval(() => void this.runCatchup(), this.runtimeConfig.catchupMs);
    this.catchupTimer.unref();
    this.heartbeatTimer = setInterval(() => this.enqueueHeartbeats(), this.runtimeConfig.heartbeatMs);
    this.heartbeatTimer.unref();
    this.retentionTimer = setInterval(() => void this.cleanupRetention(), 60 * 60 * 1000);
    this.retentionTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.listenerRetryTimer) clearTimeout(this.listenerRetryTimer);
    if (this.catchupTimer) clearInterval(this.catchupTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    for (const subscriber of this.subscribers.values()) this.closeSubscriber(subscriber);
    const client = this.listenerClient;
    this.listenerClient = null;
    if (client) {
      await client.query('UNLISTEN erp_realtime').catch(() => undefined);
      client.release();
    }
  }

  healthCheck(): HealthCheckStatus {
    if (!this.runtimeConfig.streamTransportEnabled) {
      return { status: 'ok', message: 'order realtime stream disabled' };
    }
    if (this.listenerClient) return { status: 'ok' };
    return {
      status: 'degraded',
      message: 'order realtime PostgreSQL listener is disconnected; compact polling remains available',
    };
  }

  async open(input: {
    tokenUser: CurrentUser;
    accessTokenExpiresAt: Date | undefined;
    orderId: number;
    lastEventId: string | undefined;
    response: Response;
  }): Promise<OpenOrderRealtimeStreamResult> {
    if (!input.accessTokenExpiresAt || input.accessTokenExpiresAt.getTime() <= Date.now()) {
      throw new ApiError(401, 'ACCESS_TOKEN_EXPIRED', 'Access token expired');
    }

    const authorization = await this.reader.authorize({ tokenUser: input.tokenUser, orderId: input.orderId });
    if (!(await this.runtimeConfig.isStreamEnabledForUser(authorization.currentUser.id))) {
      return 'disabled';
    }
    if (
      this.subscribers.size >= this.runtimeConfig.maxConnections ||
      this.countUserConnections(authorization.currentUser.id) >= this.runtimeConfig.maxConnectionsPerUser
    ) {
      return 'limited';
    }

    let cursor = parseOrderRealtimeCursor(input.lastEventId, {
      cutRefsAllowed: authorization.cutRefsAllowed,
    });
    if (!cursor) {
      const snapshot = await this.reader.loadSnapshot(input.orderId, authorization.cutRefsAllowed);
      cursor = {
        schemaVersion: 1,
        detailStatusRevision: snapshot.detailStatusRevision,
        ...(authorization.cutRefsAllowed ? { cutRefsRevision: snapshot.cutRefsRevision } : {}),
      };
    }

    setStreamHeaders(input.response);
    input.response.flushHeaders?.();

    const subscriber: Subscriber = {
      id: this.nextSubscriberId++,
      orderId: input.orderId,
      tokenUser: input.tokenUser,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      authorization,
      response: input.response,
      deliveredCursor: cursor,
      scannedCommitSequence: 0,
      initializing: true,
      pendingWakeCount: 0,
      drain: Promise.resolve(),
      expiryTimer: null,
      closed: false,
    };
    this.subscribers.set(subscriber.id, subscriber);
    this.scheduleSubscriberExpiry(subscriber);
    input.response.once('close', () => this.closeSubscriber(subscriber, false));

    try {
      await this.drainSubscriber(subscriber);
      subscriber.initializing = false;
      if (subscriber.pendingWakeCount > 0) this.enqueueDrain(subscriber);
      return 'opened';
    } catch (error) {
      this.logger.warn(`Order realtime initialization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      this.closeSubscriber(subscriber);
      return 'opened';
    }
  }

  private signalOrder(orderId: number): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.orderId !== orderId || subscriber.closed) continue;
      subscriber.pendingWakeCount += 1;
      if (subscriber.pendingWakeCount > this.runtimeConfig.maxQueueEvents) {
        this.sendReset(subscriber, 'buffer_overflow', subscriber.deliveredCursor);
        this.closeSubscriber(subscriber);
        continue;
      }
      if (!subscriber.initializing) this.enqueueDrain(subscriber);
    }
  }

  private enqueueDrain(subscriber: Subscriber): void {
    subscriber.drain = subscriber.drain
      .then(() => this.drainSubscriber(subscriber))
      .catch((error) => {
        this.logger.warn(`Order realtime drain failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        this.closeSubscriber(subscriber);
      });
  }

  private async drainSubscriber(subscriber: Subscriber): Promise<void> {
    if (subscriber.closed) return;
    subscriber.pendingWakeCount = 0;
    if (!(await this.assertSubscriberActive(subscriber))) return;

    const replay = await this.reader.loadReplay(
      subscriber.orderId,
      subscriber.deliveredCursor,
      subscriber.authorization.cutRefsAllowed,
      this.runtimeConfig.maxQueueEvents,
    );
    subscriber.scannedCommitSequence = replay.highWatermark;
    this.orderHighWatermarks.set(subscriber.orderId, replay.highWatermark);

    if (replay.cursorFuture || replay.retentionGap || replay.overflow) {
      this.sendReset(
        subscriber,
        replay.cursorFuture
          ? 'cursor_future'
          : replay.retentionGap
            ? 'cursor_expired'
            : 'buffer_overflow',
        replay.currentCursor,
      );
      subscriber.deliveredCursor = replay.currentCursor;
    } else {
      for (const event of replay.events) {
        if (!(await this.assertSubscriberActive(subscriber))) return;
        if (!this.sendInvalidation(subscriber, event)) return;
      }
    }

    if (subscriber.pendingWakeCount > 0 && !subscriber.closed) this.enqueueDrain(subscriber);
  }

  private async assertSubscriberActive(subscriber: Subscriber): Promise<boolean> {
    if (subscriber.closed) return false;
    if (subscriber.accessTokenExpiresAt.getTime() <= Date.now()) {
      this.closeSubscriber(subscriber);
      return false;
    }
    if (!(await this.runtimeConfig.isStreamEnabledForUser(subscriber.tokenUser.id))) {
      writeEvent(subscriber.response, 'order.realtime-disabled', undefined, {
        schemaVersion: 1,
        enabled: false,
      });
      this.closeSubscriber(subscriber);
      return false;
    }

    try {
      const current = await this.reader.authorize({
        tokenUser: subscriber.tokenUser,
        orderId: subscriber.orderId,
      });
      if (current.permissionVariant !== subscriber.authorization.permissionVariant) {
        this.closeSubscriber(subscriber);
        return false;
      }
      subscriber.authorization = current;
      return true;
    } catch {
      this.closeSubscriber(subscriber);
      return false;
    }
  }

  private sendInvalidation(subscriber: Subscriber, event: OrderRealtimeEventRecord): boolean {
    const domains = event.domains.filter(
      (domain) => domain === 'detail_status' || subscriber.authorization.cutRefsAllowed,
    );
    if (domains.length === 0) return true;

    const nextCursor = projectEventCursor(
      subscriber.deliveredCursor,
      event,
      subscriber.authorization.cutRefsAllowed,
    );
    const cursor = formatOrderRealtimeCursor(nextCursor);
    const detailIds =
      event.detailIds && event.detailIds.length <= this.runtimeConfig.maxDetailIds
        ? event.detailIds
        : null;
    const wrote = writeEvent(subscriber.response, 'order.invalidate', cursor, {
      schemaVersion: 1,
      orderId: subscriber.orderId,
      cursor,
      domains,
      detailIds,
    });
    if (!wrote) {
      this.closeSubscriber(subscriber);
      return false;
    }
    subscriber.deliveredCursor = nextCursor;
    return true;
  }

  private sendReset(
    subscriber: Subscriber,
    reason: 'cursor_expired' | 'cursor_future' | 'buffer_overflow',
    cursorValue: OrderRealtimeCursor,
  ): void {
    const cursor = formatOrderRealtimeCursor(cursorValue);
    writeEvent(subscriber.response, 'order.reset', cursor, {
      schemaVersion: 1,
      orderId: subscriber.orderId,
      cursor,
      reason,
    });
  }

  private enqueueHeartbeats(): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.drain = subscriber.drain
        .then(async () => {
          if (!(await this.assertSubscriberActive(subscriber))) return;
          if (!subscriber.response.write(': ping\n\n')) this.closeSubscriber(subscriber);
        })
        .catch(() => this.closeSubscriber(subscriber));
    }
  }

  private async runCatchup(): Promise<void> {
    if (this.catchupRunning || this.destroyed || this.subscribers.size === 0) return;
    this.catchupRunning = true;
    try {
      const orderIds = [...new Set([...this.subscribers.values()].map((entry) => entry.orderId))];
      const result = await this.database.query<StreamWatermarkRow>(
        `
        SELECT order_id, commit_sequence
        FROM order_realtime_stream
        WHERE order_id = ANY($1::bigint[])
        `,
        [orderIds],
      );
      for (const row of result.rows) {
        const orderId = Number(row.order_id);
        const highWatermark = Number(row.commit_sequence);
        if (highWatermark > (this.orderHighWatermarks.get(orderId) ?? 0)) this.signalOrder(orderId);
      }
    } catch (error) {
      this.logger.warn(`Order realtime catch-up failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.catchupRunning = false;
    }
  }

  private async cleanupRetention(): Promise<void> {
    if (!this.runtimeConfig.writesEnabled || this.destroyed) return;
    try {
      await this.database.query(
        `
        WITH doomed AS (
          SELECT ctid
          FROM realtime_event_log
          WHERE created_at < now() - make_interval(hours => $1)
          ORDER BY created_at
          LIMIT 5000
        )
        DELETE FROM realtime_event_log e
        USING doomed
        WHERE e.ctid = doomed.ctid
        `,
        [this.runtimeConfig.retentionHours],
      );
    } catch (error) {
      this.logger.warn(`Order realtime retention cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async connectListener(): Promise<void> {
    if (this.destroyed || this.listenerClient) return;
    const generation = ++this.listenerGeneration;
    let client: PoolClient | null = null;
    try {
      client = await this.database.connectDedicated('Order realtime LISTEN connect');
      if (this.destroyed || generation !== this.listenerGeneration) {
        client.release();
        return;
      }
      const connectedClient = client;
      this.listenerClient = connectedClient;
      connectedClient.on('notification', (notification: Notification) => {
        if (notification.channel !== 'erp_realtime') return;
        if (notification.payload === 'wake') {
          void this.runCatchup();
          return;
        }
        const orderId = parseNotificationOrderId(notification.payload);
        if (orderId !== null) this.signalOrder(orderId);
      });
      const disconnect = () => this.handleListenerDisconnect(connectedClient, generation);
      connectedClient.once('error', disconnect);
      connectedClient.once('end', disconnect);
      await connectedClient.query('LISTEN erp_realtime');
    } catch (error) {
      if (client && this.listenerClient === client) {
        this.listenerClient = null;
        client.release(true);
      }
      this.logger.warn(`Order realtime LISTEN unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      this.scheduleListenerReconnect();
    }
  }

  private handleListenerDisconnect(client: PoolClient, generation: number): void {
    if (this.listenerClient !== client || generation !== this.listenerGeneration) return;
    this.listenerClient = null;
    client.release(true);
    this.scheduleListenerReconnect();
  }

  private scheduleListenerReconnect(): void {
    if (this.destroyed || this.listenerRetryTimer) return;
    this.listenerRetryTimer = setTimeout(() => {
      this.listenerRetryTimer = null;
      void this.connectListener();
    }, Math.min(30000, Math.max(1000, this.runtimeConfig.catchupMs)));
    this.listenerRetryTimer.unref();
  }

  private scheduleSubscriberExpiry(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    const remainingMs = subscriber.accessTokenExpiresAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      this.closeSubscriber(subscriber);
      return;
    }

    subscriber.expiryTimer = setTimeout(() => {
      subscriber.expiryTimer = null;
      this.scheduleSubscriberExpiry(subscriber);
    }, Math.min(remainingMs, 2_147_483_647));
    subscriber.expiryTimer.unref();
  }

  private closeSubscriber(subscriber: Subscriber, endResponse = true): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.expiryTimer) {
      clearTimeout(subscriber.expiryTimer);
      subscriber.expiryTimer = null;
    }
    this.subscribers.delete(subscriber.id);
    if (![...this.subscribers.values()].some((entry) => entry.orderId === subscriber.orderId)) {
      this.orderHighWatermarks.delete(subscriber.orderId);
    }
    if (endResponse && !subscriber.response.writableEnded) subscriber.response.end();
  }

  private countUserConnections(userId: string): number {
    let count = 0;
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.authorization.currentUser.id === userId) count += 1;
    }
    return count;
  }
}

export function projectEventCursor(
  cursor: OrderRealtimeCursor,
  event: OrderRealtimeEventRecord,
  cutRefsAllowed: boolean,
): OrderRealtimeCursor {
  return {
    schemaVersion: 1,
    detailStatusRevision: event.detailStatusRevision ?? cursor.detailStatusRevision,
    ...(cutRefsAllowed
      ? { cutRefsRevision: event.cutRefsRevision ?? cursor.cutRefsRevision ?? 0 }
      : {}),
  };
}

function setStreamHeaders(response: Response): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'private, no-cache, no-transform');
  response.setHeader('Vary', 'Authorization, Origin');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.setHeader('X-ERP-Realtime-Enabled', 'true');
}

function writeEvent(
  response: Response,
  event: string,
  id: string | undefined,
  data: Record<string, unknown>,
): boolean {
  const lines = [
    ...(id ? [`id: ${id}`] : []),
    `event: ${event}`,
    'retry: 3000',
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ];
  return response.write(lines.join('\n'));
}

function parseNotificationOrderId(payload: string | undefined): number | null {
  const match = /^(\d+):wake$/.exec(payload ?? '');
  if (!match) return null;
  const orderId = Number(match[1]);
  return Number.isSafeInteger(orderId) && orderId > 0 ? orderId : null;
}
