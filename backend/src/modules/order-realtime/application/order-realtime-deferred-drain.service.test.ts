import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  ORDER_REALTIME_DRAIN_TABLE_LOCKS,
  OrderRealtimeDeferredDrainService,
  type DrainConnection,
} from './order-realtime-deferred-drain.service';

type Handler = (text: string, params?: unknown[]) => { rows: Record<string, unknown>[] } | Promise<{ rows: Record<string, unknown>[] }>;

class FakeConnection implements DrainConnection {
  readonly sql: string[] = [];
  ended = false;
  constructor(private readonly handler: Handler = () => ({ rows: [] })) {}
  async query<T>(text: string, params?: unknown[]) {
    this.sql.push(text.replace(/\s+/g, ' ').trim());
    return (await this.handler(text, params)) as { rows: T[] };
  }
  async end() { this.ended = true; }
}

function service(enabled: boolean, connection: FakeConnection) {
  const config = new ConfigService({ BACKEND_ORDER_REALTIME_DEFERRED_DRAIN: enabled, DATABASE_URL: 'postgresql://e2e/none' });
  const drain = new (class extends OrderRealtimeDeferredDrainService {
    opened = 0;
    protected override async openConnection() { this.opened += 1; return connection; }
  })(config as never);
  return drain;
}

const lockError = () => Object.assign(new Error('could not obtain lock'), { code: '55P03' });
const queued = [{ order_realtime_deferred_id: 7, domains: ['detail_status'], detail_ids: ['11'], source_type: 'order_details' }];

describe('OrderRealtimeDeferredDrainService («Переделка» §5.7 п.5)', () => {
  it('replays the queue without waiting: NOWAIT table locks first, SKIP LOCKED rows, NOWAIT stream/order, emit, delete, notify', async () => {
    const connection = new FakeConnection((text) => {
      if (text.includes('FROM order_realtime_deferred') && text.includes('SKIP LOCKED')) return { rows: queued };
      if (text.includes('FROM order_realtime_stream')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('order_realtime_emit_one')) return { rows: [{ emitted: true }] };
      return { rows: [] };
    });
    await expect(service(true, connection).drainOrder(42)).resolves.toBe('delivered');
    expect(connection.sql).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '50ms'",
      ...ORDER_REALTIME_DRAIN_TABLE_LOCKS,
      'SELECT order_realtime_deferred_id, domains, detail_ids, source_type FROM order_realtime_deferred WHERE order_id = $1 ORDER BY order_realtime_deferred_id FOR UPDATE SKIP LOCKED',
      'SELECT 1 FROM order_realtime_stream WHERE order_id = $1 FOR UPDATE NOWAIT',
      'SELECT 1 FROM orders WHERE order_id = $1 FOR KEY SHARE NOWAIT',
      'SELECT order_realtime_emit_one($1::bigint, $2::text[], $3::bigint[], $4::text) AS emitted',
      'DELETE FROM order_realtime_deferred WHERE order_realtime_deferred_id = ANY($1::bigint[])',
      "SELECT pg_notify('erp_realtime', 'wake')",
      'COMMIT',
    ]);
  });

  it('a lock conflict rolls the attempt back, keeps the queue and backs off without waiting', async () => {
    const connection = new FakeConnection((text) => {
      if (text.trim().startsWith('SELECT order_realtime_deferred_id')) return { rows: queued };
      if (text.includes('FROM order_realtime_stream')) throw lockError();
      return { rows: [] };
    });
    await expect(service(true, connection).drainOrder(42)).resolves.toBe('busy');
    expect(connection.sql).toContain('ROLLBACK');
    expect(connection.sql.some((sql) => sql.startsWith('DELETE'))).toBe(false);
    const backoff = connection.sql.slice(connection.sql.lastIndexOf('BEGIN'));
    expect(backoff[2]).toBe('LOCK TABLE order_realtime_deferred IN ROW EXCLUSIVE MODE NOWAIT');
    expect(backoff[3]).toContain('attempts = attempts + 1');
    expect(backoff[3]).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('keeps the queue when the realtime bridge was switched off after the command', async () => {
    const connection = new FakeConnection((text) => {
      if (text.trim().startsWith('SELECT order_realtime_deferred_id')) return { rows: queued };
      if (text.includes('FROM order_realtime_stream')) return { rows: [{ '?column?': 1 }] };
      if (text.includes('order_realtime_emit_one')) return { rows: [{ emitted: false }] };
      return { rows: [] };
    });
    await expect(service(true, connection).drainOrder(42)).resolves.toBe('bridge_disabled');
    expect(connection.sql).toContain('ROLLBACK');
    expect(connection.sql.some((sql) => sql.startsWith('DELETE'))).toBe(false);
    expect(connection.sql.some((sql) => sql.includes('attempts = attempts + 1'))).toBe(true);
  });

  it('never creates a missing stream row; the queue stays for a later attempt', async () => {
    const connection = new FakeConnection((text) => {
      if (text.trim().startsWith('SELECT order_realtime_deferred_id')) return { rows: queued };
      return { rows: [] };
    });
    await expect(service(true, connection).drainOrder(42)).resolves.toBe('stream_missing');
    expect(connection.sql.some((sql) => /INSERT INTO order_realtime_stream/i.test(sql))).toBe(false);
    expect(connection.sql.some((sql) => sql.startsWith('DELETE'))).toBe(false);
  });

  it('with BACKEND_ORDER_REALTIME_DEFERRED_DRAIN=false neither the immediate drain nor the sweeper runs', async () => {
    const connection = new FakeConnection();
    const drain = service(false, connection);
    drain.onModuleInit();
    drain.request([42]);
    drain.sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drain.opened).toBe(0);
    expect(connection.sql).toEqual([]);
    await drain.onModuleDestroy();
  });

  it('stop waits for the active attempt, starts no new one and logs «drain stopped»', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const connection = new FakeConnection(async (text) => {
      if (text.includes('FROM order_realtime_deferred') && text.includes('SKIP LOCKED')) { await gate; return { rows: [] }; }
      return { rows: [] };
    });
    const drain = service(true, connection);
    const log = vi.spyOn((drain as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    drain.request([1, 2]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = drain.onModuleDestroy();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(log).toHaveBeenCalledWith('drain stopped');
    expect(connection.ended).toBe(true);
    // Order 2 was never started after the stop.
    expect(connection.sql.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    drain.request([3]);
    expect(connection.sql.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
  });

  it('a real SIGTERM through Nest shutdown hooks finishes the active attempt and logs «drain stopped»', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const connection = new FakeConnection(async (text) => {
      if (text.trim().startsWith('SELECT order_realtime_deferred_id')) { await gate; return { rows: [] }; }
      return { rows: [] };
    });
    class FakeDrain extends OrderRealtimeDeferredDrainService {
      protected override async openConnection() { return connection; }
    }
    @Module({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({
        BACKEND_ORDER_REALTIME_DEFERRED_DRAIN: true, DATABASE_URL: 'postgresql://e2e/none' })] })],
      providers: [{ provide: OrderRealtimeDeferredDrainService, useClass: FakeDrain }],
    })
    class DrainTestModule {}
    const app = await NestFactory.createApplicationContext(DrainTestModule, { logger: false });
    app.enableShutdownHooks(['SIGTERM']);
    const drain = app.get(OrderRealtimeDeferredDrainService);
    const log = vi.spyOn((drain as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    const killed = new Promise<void>((resolve) => {
      vi.spyOn(process, 'kill').mockImplementation(() => { resolve(); return true; });
    });
    try {
      drain.request([1, 2]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.emit('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(log).not.toHaveBeenCalledWith('drain stopped');
      release();
      await killed;
      expect(log).toHaveBeenCalledWith('drain stopped');
      expect(connection.ended).toBe(true);
      // Only order 1's attempt ran (after the startup sweep); order 2 never started after SIGTERM.
      expect(connection.sql.filter((sql) => sql.startsWith('SELECT order_realtime_deferred_id'))).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('bootstrap enables SIGTERM/SIGINT shutdown hooks before listening', () => {
    const main = readFileSync(join(__dirname, '../../../main.ts'), 'utf8');
    const hooks = main.indexOf("app.enableShutdownHooks(['SIGTERM', 'SIGINT'])");
    expect(hooks).toBeGreaterThan(0);
    expect(hooks).toBeLessThan(main.indexOf('await app.listen('));
  });

  it('source guard: the drain only locks NOWAIT/SKIP LOCKED and never inserts the stream row', () => {
    const source = readFileSync(join(__dirname, 'order-realtime-deferred-drain.service.ts'), 'utf8');
    const sql = [...source.matchAll(/`([^`]*)`|'([^']*(?:SELECT|UPDATE|LOCK|DELETE)[^']*)'/g)].map((m) => m[1] ?? m[2]);
    for (const statement of sql.filter((text) => /\bFOR (UPDATE|KEY SHARE|SHARE|NO KEY UPDATE)\b/.test(text))) {
      expect(statement).toMatch(/NOWAIT|SKIP LOCKED/);
    }
    for (const statement of sql.filter((text) => /^LOCK TABLE/.test(text.trim()))) expect(statement).toContain('NOWAIT');
    expect(source).not.toMatch(/INSERT INTO order_realtime_stream/i);
  });
});
