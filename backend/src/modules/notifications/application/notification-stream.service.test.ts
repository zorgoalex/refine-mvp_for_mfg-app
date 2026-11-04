import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { NOTIFICATION_SIGNAL_CHANNEL, NotificationStreamService } from './notification-stream.service';

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  writableEnded = false;
  writeResult = true;
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: string) { this.headers[name] = value; }
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(chunk); return this.writeResult; }
  end() { this.writableEnded = true; this.emit('close'); }
  events(name: string) { return this.chunks.filter((chunk) => chunk.startsWith(`event: ${name}\n`)); }
}

class FakeListener extends EventEmitter {
  readonly queries: string[] = [];
  ended = false;
  async query(text: string) { this.queries.push(text); return { rows: [] }; }
  async end() { this.ended = true; }
  notify(payload: string, channel = NOTIFICATION_SIGNAL_CHANNEL) { this.emit('notification', { channel, payload }); }
}

const settings = {
  BACKEND_NOTIFICATION_STREAM_ENABLED: true,
  BACKEND_NOTIFICATION_STREAM_MAX_CONNECTIONS: 3,
  BACKEND_NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_USER: 2,
  BACKEND_NOTIFICATION_STREAM_HEARTBEAT_MS: 25_000,
  BACKEND_NOTIFICATION_STREAM_RESERVED_DB_CONNECTIONS: 3,
};

function setup(overrides: Partial<typeof settings> = {}, budget = { max_connections: 100, used: 10, reserved: 3 }) {
  const values = { ...settings, ...overrides };
  const config = { get: (key: keyof typeof values) => values[key] } as unknown as ConfigService<never, true>;
  const listeners: FakeListener[] = [];
  const database = {
    isConfigured: true,
    query: vi.fn(async () => ({ rows: [budget] })),
    connectUnpooled: vi.fn(async () => {
      const listener = new FakeListener();
      listeners.push(listener);
      return listener;
    }),
  } as unknown as DatabaseService & { query: ReturnType<typeof vi.fn>; connectUnpooled: ReturnType<typeof vi.fn> };
  const service = new NotificationStreamService(database, config as never);
  return { service, database, listeners };
}

const user = (id: string) => ({ id, username: `u${id}`, role: 'admin', roleId: 1, permissions: [] }) as unknown as CurrentUser;
const inAnHour = () => new Date(Date.now() + 3_600_000);

describe('NotificationStreamService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('disabled → 204-path, no LISTEN; expired token → 401', async () => {
    const { service, database } = setup({ BACKEND_NOTIFICATION_STREAM_ENABLED: false });
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(database.connectUnpooled).not.toHaveBeenCalled();
    expect(service.open({ tokenUser: user('1'), accessTokenExpiresAt: inAnHour(), response: new FakeResponse() as unknown as Response })).toBe('disabled');
    expect(() => service.open({ tokenUser: user('1'), accessTokenExpiresAt: new Date(Date.now() - 1), response: new FakeResponse() as unknown as Response }))
      .toThrow(/expired/i);
  });

  it('opens SSE with `hello`, LISTENs outside the pool and sends `changed` only to the signalled user (debounced)', async () => {
    const { service, database, listeners } = setup();
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(database.connectUnpooled).toHaveBeenCalledTimes(1);
    expect(listeners[0].queries).toEqual([`LISTEN ${NOTIFICATION_SIGNAL_CHANNEL}`]);

    const a = new FakeResponse();
    const b = new FakeResponse();
    expect(service.open({ tokenUser: user('7'), accessTokenExpiresAt: inAnHour(), response: a as unknown as Response })).toBe('opened');
    service.open({ tokenUser: user('8'), accessTokenExpiresAt: inAnHour(), response: b as unknown as Response });
    expect(a.headers['Content-Type']).toContain('text/event-stream');
    expect(a.events('hello')[0]).toContain('"listening":true');

    listeners[0].notify('7');
    listeners[0].notify('7');
    listeners[0].notify('not-a-user');
    listeners[0].notify('8', 'other_channel');
    expect(a.events('changed')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(a.events('changed')).toHaveLength(1);
    expect(b.events('changed')).toHaveLength(0);
  });

  it('limits connections per user and per process', async () => {
    const { service } = setup();
    const open = (id: string) => service.open({ tokenUser: user(id), accessTokenExpiresAt: inAnHour(), response: new FakeResponse() as unknown as Response });
    expect(open('1')).toBe('opened');
    expect(open('1')).toBe('opened');
    expect(open('1')).toBe('limited');
    expect(open('2')).toBe('opened');
    expect(open('3')).toBe('limited');
  });

  it('closes a stream when its access token expires and on a failed write; client close removes it', async () => {
    const { service } = setup();
    const expiring = new FakeResponse();
    service.open({ tokenUser: user('1'), accessTokenExpiresAt: new Date(Date.now() + 1_000), response: expiring as unknown as Response });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(expiring.writableEnded).toBe(true);
    const clientGone = new FakeResponse();
    service.open({ tokenUser: user('2'), accessTokenExpiresAt: inAnHour(), response: clientGone as unknown as Response });
    clientGone.emit('close');
    expect(service.connectionCount).toBe(0);
  });

  it('after the LISTEN connection is lost and restored, every subscriber gets `changed`', async () => {
    const { service, listeners } = setup();
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    const a = new FakeResponse();
    service.open({ tokenUser: user('7'), accessTokenExpiresAt: inAnHour(), response: a as unknown as Response });
    listeners[0].emit('error', new Error('connection reset'));
    expect(service.healthCheck().status).toBe('degraded');
    expect(a.events('listener').at(-1)).toContain('"listening":false');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listeners).toHaveLength(2);
    expect(a.events('listener').at(-1)).toContain('"listening":true');
    expect(a.events('changed')[0]).toContain('listener_reconnected');
    expect(service.healthCheck().status).toBe('ok');
  });

  it('first LISTEN after an initial failure also re-syncs the subscribers that opened meanwhile', async () => {
    const { service, database, listeners } = setup();
    database.connectUnpooled.mockRejectedValueOnce(new Error('db down'));
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    const a = new FakeResponse();
    service.open({ tokenUser: user('7'), accessTokenExpiresAt: inAnHour(), response: a as unknown as Response });
    expect(a.events('hello')[0]).toContain('"listening":false');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listeners).toHaveLength(1);
    expect(a.events('listener').at(-1)).toContain('"listening":true');
    expect(a.events('changed')).toHaveLength(1);
  });

  it('does not open the LISTEN connection when PostgreSQL would keep too few free connections', async () => {
    const { service, database } = setup({}, { max_connections: 20, used: 15, reserved: 3 });
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(database.connectUnpooled).not.toHaveBeenCalled();
    expect(service.healthCheck()).toMatchObject({ status: 'degraded' });
    expect(String(service.healthCheck().message)).toContain('not enough free PostgreSQL connections');
  });

  it('heartbeats keep streams alive; a stream whose write fails is closed', async () => {
    const { service } = setup();
    service.onModuleInit();
    const a = new FakeResponse();
    service.open({ tokenUser: user('7'), accessTokenExpiresAt: inAnHour(), response: a as unknown as Response });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(a.chunks).toContain(': ping\n\n');
    a.writeResult = false;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(service.connectionCount).toBe(0);
  });
});
