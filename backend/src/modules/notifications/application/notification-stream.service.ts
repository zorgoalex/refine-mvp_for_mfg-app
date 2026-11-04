import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Client, Notification } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { HealthCheckStatus } from '../../health/health.contract';

/** pg_notify channel of migration 294: payload = user_id whose notifications changed. */
export const NOTIFICATION_SIGNAL_CHANNEL = 'erp_user_notifications';
const DEBOUNCE_MS = 300;
const RECONNECT_MS = 5_000;

export type OpenNotificationStreamResult = 'opened' | 'disabled' | 'limited';

interface Subscriber {
  id: number;
  userId: string;
  response: Response;
  accessTokenExpiresAt: Date;
  expiryTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface NotificationStreamSettings {
  enabled: boolean;
  maxConnections: number;
  maxConnectionsPerUser: number;
  heartbeatMs: number;
  reservedDbConnections: number;
}

/**
 * Server push for the bell and balloons (plan part B): the browser keeps one SSE stream per tab; when a user's
 * notifications change (migration 294 → pg_notify) the stream sends `changed` and the tab re-reads the list and the
 * balloons through the usual endpoints (their own permission checks). The signal carries no data.
 *
 * One LISTEN per process on a connection OUTSIDE the working pool; it is opened only if PostgreSQL keeps
 * `reservedDbConnections` free afterwards, otherwise the stream stays down (health degraded, tabs fall back to polling).
 * After the LISTEN connection is restored every local subscriber gets `changed`: signals of the gap may be lost.
 */
@Injectable()
export class NotificationStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationStreamService.name);
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly pendingUsers = new Set<string>();
  private nextSubscriberId = 1;
  private listener: Client | null = null;
  private listenerConnecting = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private lastListenerError: string | null = null;
  readonly settings: NotificationStreamSettings;

  constructor(
    private readonly database: DatabaseService,
    @Inject(ConfigService) config: ConfigService<BackendEnv, true>,
  ) {
    this.settings = {
      enabled: config.get('BACKEND_NOTIFICATION_STREAM_ENABLED', { infer: true }),
      maxConnections: config.get('BACKEND_NOTIFICATION_STREAM_MAX_CONNECTIONS', { infer: true }),
      maxConnectionsPerUser: config.get('BACKEND_NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_USER', { infer: true }),
      heartbeatMs: config.get('BACKEND_NOTIFICATION_STREAM_HEARTBEAT_MS', { infer: true }),
      reservedDbConnections: config.get('BACKEND_NOTIFICATION_STREAM_RESERVED_DB_CONNECTIONS', { infer: true }),
    };
  }

  onModuleInit(): void {
    if (!this.settings.enabled || !this.database.isConfigured) return;
    void this.connectListener();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.settings.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const timer of [this.retryTimer, this.debounceTimer]) if (timer) clearTimeout(timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const subscriber of [...this.subscribers.values()]) this.closeSubscriber(subscriber);
    const client = this.listener;
    this.listener = null;
    if (client) await client.end().catch(() => undefined);
  }

  healthCheck(): HealthCheckStatus {
    if (!this.settings.enabled) return { status: 'ok', message: 'notification stream disabled' };
    if (this.listener) return { status: 'ok' };
    return {
      status: 'degraded',
      message: `notification stream listener is down${this.lastListenerError ? `: ${this.lastListenerError}` : ''}; tabs poll instead`,
    };
  }

  /** Opens the SSE stream of the current user. */
  open(input: { tokenUser: CurrentUser; accessTokenExpiresAt: Date | undefined; response: Response }): OpenNotificationStreamResult {
    if (!input.accessTokenExpiresAt || input.accessTokenExpiresAt.getTime() <= Date.now()) {
      throw new ApiError(401, 'ACCESS_TOKEN_EXPIRED', 'Access token expired');
    }
    if (!this.settings.enabled) return 'disabled';
    const userId = String(input.tokenUser.id);
    if (this.subscribers.size >= this.settings.maxConnections || this.countUser(userId) >= this.settings.maxConnectionsPerUser) {
      return 'limited';
    }

    const response = input.response;
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-cache, no-transform');
    response.setHeader('Vary', 'Authorization, Origin');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    const subscriber: Subscriber = {
      id: this.nextSubscriberId++, userId, response, accessTokenExpiresAt: input.accessTokenExpiresAt,
      expiryTimer: null, closed: false,
    };
    this.subscribers.set(subscriber.id, subscriber);
    this.scheduleExpiry(subscriber);
    response.once('close', () => this.closeSubscriber(subscriber, false));
    // `hello` on every (re)connect: the tab re-syncs, whatever it missed while disconnected.
    if (!writeEvent(response, 'hello', { schemaVersion: 1, listening: this.listener !== null })) this.closeSubscriber(subscriber);
    return 'opened';
  }

  /** A user's notifications changed (LISTEN). Debounced: several changes of one transaction burst → one `changed`. */
  signalUser(userId: string): void {
    if (!this.hasUser(userId)) return;
    this.pendingUsers.add(userId);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const users = [...this.pendingUsers];
      this.pendingUsers.clear();
      for (const subscriber of [...this.subscribers.values()]) {
        if (users.includes(subscriber.userId)) this.sendChanged(subscriber, 'signal');
      }
    }, DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  /** `listener` event: whether signals are delivered right now (tabs poll every minute while they are not). */
  private broadcastListener(listening: boolean): void {
    for (const subscriber of [...this.subscribers.values()]) {
      if (!writeEvent(subscriber.response, 'listener', { schemaVersion: 1, listening })) this.closeSubscriber(subscriber);
    }
  }

  /** After a LISTEN connection is established: signals of the gap may be lost → everyone re-syncs. */
  signalAll(reason: 'listener_reconnected'): void {
    for (const subscriber of [...this.subscribers.values()]) this.sendChanged(subscriber, reason);
  }

  get connectionCount(): number {
    return this.subscribers.size;
  }

  private sendChanged(subscriber: Subscriber, reason: string): void {
    if (subscriber.closed) return;
    if (subscriber.accessTokenExpiresAt.getTime() <= Date.now()) {
      this.closeSubscriber(subscriber);
      return;
    }
    if (!writeEvent(subscriber.response, 'changed', { schemaVersion: 1, reason })) this.closeSubscriber(subscriber);
  }

  private sendHeartbeats(): void {
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.accessTokenExpiresAt.getTime() <= Date.now()) {
        this.closeSubscriber(subscriber);
        continue;
      }
      if (!subscriber.response.write(': ping\n\n')) this.closeSubscriber(subscriber);
    }
  }

  private async connectListener(): Promise<void> {
    if (this.destroyed || this.listener || this.listenerConnecting) return;
    this.listenerConnecting = true;
    let client: Client | null = null;
    try {
      await this.assertConnectionBudget();
      client = await this.database.connectUnpooled('Notification stream LISTEN connect');
      if (this.destroyed) {
        await client.end().catch(() => undefined);
        return;
      }
      const connected = client;
      connected.on('notification', (message: Notification) => {
        if (message.channel !== NOTIFICATION_SIGNAL_CHANNEL) return;
        const userId = parseUserId(message.payload);
        if (userId) this.signalUser(userId);
      });
      const lost = () => this.handleListenerLost(connected);
      connected.once('error', lost);
      connected.once('end', lost);
      await connected.query(`LISTEN ${NOTIFICATION_SIGNAL_CHANNEL}`);
      this.listener = connected;
      this.lastListenerError = null;
      // Every LISTEN establishment (the first one too): signals sent before it may be lost → everyone re-syncs.
      this.broadcastListener(true);
      this.signalAll('listener_reconnected');
    } catch (error) {
      this.lastListenerError = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Notification stream LISTEN unavailable: ${this.lastListenerError}`);
      if (client) await client.end().catch(() => undefined);
      this.scheduleReconnect();
    } finally {
      this.listenerConnecting = false;
    }
  }

  /** PostgreSQL must keep `reservedDbConnections` free after this extra connection; otherwise do not open it. */
  private async assertConnectionBudget(): Promise<void> {
    const result = await this.database.query<{ max_connections: string | number; used: string | number; reserved: string | number }>(
      `SELECT current_setting('max_connections')::int AS max_connections,
              (SELECT count(*) FROM pg_stat_activity)::int AS used,
              current_setting('superuser_reserved_connections')::int AS reserved`,
    );
    const row = result.rows[0];
    const free = Number(row.max_connections) - Number(row.reserved) - Number(row.used);
    if (free - 1 < this.settings.reservedDbConnections) {
      throw new Error(`not enough free PostgreSQL connections (${free} free, ${this.settings.reservedDbConnections} must stay free)`);
    }
  }

  private handleListenerLost(client: Client): void {
    if (this.listener !== client) return;
    this.listener = null;
    // Tabs switch to their 60-second fallback until `listening: true` comes back.
    this.broadcastListener(false);
    void client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectListener();
    }, RECONNECT_MS);
    this.retryTimer.unref();
  }

  private scheduleExpiry(subscriber: Subscriber): void {
    const remaining = subscriber.accessTokenExpiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      this.closeSubscriber(subscriber);
      return;
    }
    subscriber.expiryTimer = setTimeout(() => {
      subscriber.expiryTimer = null;
      this.scheduleExpiry(subscriber);
    }, Math.min(remaining, 2_147_483_647));
    subscriber.expiryTimer.unref();
  }

  private closeSubscriber(subscriber: Subscriber, endResponse = true): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.expiryTimer) clearTimeout(subscriber.expiryTimer);
    subscriber.expiryTimer = null;
    this.subscribers.delete(subscriber.id);
    if (endResponse && !subscriber.response.writableEnded) subscriber.response.end();
  }

  private countUser(userId: string): number {
    let count = 0;
    for (const subscriber of this.subscribers.values()) if (subscriber.userId === userId) count += 1;
    return count;
  }

  private hasUser(userId: string): boolean {
    for (const subscriber of this.subscribers.values()) if (subscriber.userId === userId) return true;
    return false;
  }
}

function writeEvent(response: Response, event: string, data: Record<string, unknown>): boolean {
  return response.write(`event: ${event}\nretry: 3000\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseUserId(payload: string | undefined): string | null {
  return payload && /^\d+$/.test(payload) ? payload : null;
}
