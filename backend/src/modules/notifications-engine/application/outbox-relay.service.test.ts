import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port';
import {
  OutboxRelayService,
  type OutboxConsumer,
  type OutboxRelayDatabase,
  type OutboxRelayDeps,
} from './outbox-relay.service';

const fakeClient = {} as any;
const FIXED_NOW = new Date('2026-06-07T00:00:00Z');

function event(overrides: Partial<OutboxEventRecord> = {}): OutboxEventRecord {
  return {
    outboxEventId: 'outbox-1',
    eventType: 'order.production_status_changed',
    aggregateType: 'order',
    aggregateId: '500',
    payload: {},
    attempts: 0,
    ...overrides,
  };
}

function fakeOutboxRepo(overrides: Partial<OutboxRepositoryPort> = {}): OutboxRepositoryPort & {
  claimPendingBatch: ReturnType<typeof vi.fn>;
  markProcessed: ReturnType<typeof vi.fn>;
  markRetry: ReturnType<typeof vi.fn>;
} {
  return {
    claimPendingBatch: vi.fn(async () => []),
    markProcessed: vi.fn(async () => undefined),
    markRetry: vi.fn(async () => ({ status: 'pending' as const, attempts: 1 })),
    ...overrides,
  } as any;
}

function fakeDatabase(): OutboxRelayDatabase & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(),
    transaction: vi.fn(async (handler: (client: unknown) => Promise<unknown>) => handler(fakeClient)),
  } as any;
}

function fakeConsumer(overrides: Partial<OutboxConsumer> = {}): OutboxConsumer & {
  supports: ReturnType<typeof vi.fn>;
  process: ReturnType<typeof vi.fn>;
} {
  return {
    supports: vi.fn(() => true),
    process: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

function buildService(overrides: Partial<OutboxRelayDeps> = {}) {
  const outboxRepo = overrides.outboxRepo ?? fakeOutboxRepo();
  const database = overrides.database ?? fakeDatabase();
  const consumers = overrides.consumers ?? [fakeConsumer()];
  const deps: OutboxRelayDeps = {
    database,
    outboxRepo,
    consumers,
    config: { workerId: 'worker-1', batchSize: 10, maxAttempts: 5 },
    now: () => FIXED_NOW,
    ...overrides,
  };
  return { service: new OutboxRelayService(deps), deps, outboxRepo, database, consumers };
}

describe('OutboxRelayService', () => {
  describe('processBatchOnce', () => {
    it('processes a happy-path batch: each event gets its own transaction and is marked processed', async () => {
      const events = [event({ outboxEventId: 'outbox-1' }), event({ outboxEventId: 'outbox-2' })];
      const consumer = fakeConsumer({ supports: vi.fn(() => true) });
      const outboxRepo = fakeOutboxRepo({ claimPendingBatch: vi.fn(async () => events) });
      const database = fakeDatabase();

      const { service } = buildService({ outboxRepo, database, consumers: [consumer] });
      const summary = await service.processBatchOnce();

      expect(summary).toEqual({ claimed: 2, processed: 2, failed: 0 });
      expect(outboxRepo.markProcessed).toHaveBeenCalledTimes(2);
      expect(outboxRepo.markProcessed).toHaveBeenNthCalledWith(1, fakeClient, 'outbox-1');
      expect(outboxRepo.markProcessed).toHaveBeenNthCalledWith(2, fakeClient, 'outbox-2');
      expect(outboxRepo.markRetry).not.toHaveBeenCalled();
      expect(database.transaction).toHaveBeenCalledTimes(2);
      expect(consumer.process).toHaveBeenCalledTimes(2);

      expect(outboxRepo.claimPendingBatch).toHaveBeenCalledWith(database, {
        batchSize: 10,
        workerId: 'worker-1',
        now: FIXED_NOW,
      });
    });

    it('marks unsupported events as processed without invoking any consumer, and only invokes supporting consumers', async () => {
      const supportedEvent = event({ outboxEventId: 'outbox-supported', eventType: 'order.production_status_changed' });
      const unsupportedEvent = event({ outboxEventId: 'outbox-unsupported', eventType: 'unknown.event_type' });
      const events = [supportedEvent, unsupportedEvent];

      const supportingConsumer = fakeConsumer({
        supports: vi.fn((eventType: string) => eventType === 'order.production_status_changed'),
      });
      const otherConsumer = fakeConsumer({
        supports: vi.fn((eventType: string) => eventType === 'something.else'),
      });

      const outboxRepo = fakeOutboxRepo({ claimPendingBatch: vi.fn(async () => events) });
      const { service } = buildService({ outboxRepo, consumers: [supportingConsumer, otherConsumer] });

      const summary = await service.processBatchOnce();

      expect(summary).toEqual({ claimed: 2, processed: 2, failed: 0 });
      expect(outboxRepo.markProcessed).toHaveBeenCalledTimes(2);
      expect(outboxRepo.markProcessed).toHaveBeenNthCalledWith(1, fakeClient, 'outbox-supported');
      expect(outboxRepo.markProcessed).toHaveBeenNthCalledWith(2, fakeClient, 'outbox-unsupported');

      // supportingConsumer only processes the event it supports
      expect(supportingConsumer.process).toHaveBeenCalledTimes(1);
      expect(supportingConsumer.process).toHaveBeenCalledWith(fakeClient, supportedEvent);

      // otherConsumer supports neither event -> never processes
      expect(otherConsumer.process).not.toHaveBeenCalled();
    });

    it('does not let one failing event roll back or affect a sibling event (independent per-event transactions)', async () => {
      const eventA = event({ outboxEventId: 'outbox-a', attempts: 3 });
      const eventB = event({ outboxEventId: 'outbox-b', attempts: 0 });
      const events = [eventA, eventB];

      const consumer = fakeConsumer({
        supports: vi.fn(() => true),
        process: vi.fn(async (_client: unknown, evt: OutboxEventRecord) => {
          if (evt.outboxEventId === 'outbox-a') {
            throw new Error('boom-a');
          }
        }),
      });

      const outboxRepo = fakeOutboxRepo({ claimPendingBatch: vi.fn(async () => events) });
      const database = fakeDatabase();
      const { service } = buildService({ outboxRepo, database, consumers: [consumer] });

      const summary = await service.processBatchOnce();

      expect(summary).toEqual({ claimed: 2, processed: 1, failed: 1 });

      // B succeeded independently
      expect(outboxRepo.markProcessed).toHaveBeenCalledTimes(1);
      expect(outboxRepo.markProcessed).toHaveBeenCalledWith(fakeClient, 'outbox-b');

      // A retried with computed backoff: min(2^attempts, 3600) seconds from `now`
      expect(outboxRepo.markRetry).toHaveBeenCalledTimes(1);
      const expectedBackoffMs = Math.min(2 ** eventA.attempts, 3600) * 1000;
      expect(outboxRepo.markRetry).toHaveBeenCalledWith(database, 'outbox-a', {
        nextAttemptAt: new Date(FIXED_NOW.getTime() + expectedBackoffMs),
        maxAttempts: 5,
      });

      // Each event ran in its own `database.transaction` call
      expect(database.transaction).toHaveBeenCalledTimes(2);
    });

    it('caps the backoff at 3600 seconds for events with large attempt counts', async () => {
      const bigAttemptsEvent = event({ outboxEventId: 'outbox-cap', attempts: 20 });
      const consumer = fakeConsumer({
        process: vi.fn(async () => {
          throw new Error('always fails');
        }),
      });
      const outboxRepo = fakeOutboxRepo({ claimPendingBatch: vi.fn(async () => [bigAttemptsEvent]) });
      const database = fakeDatabase();
      const { service } = buildService({ outboxRepo, database, consumers: [consumer] });

      const summary = await service.processBatchOnce();

      expect(summary).toEqual({ claimed: 1, processed: 0, failed: 1 });
      expect(outboxRepo.markRetry).toHaveBeenCalledTimes(1);
      expect(outboxRepo.markRetry).toHaveBeenCalledWith(database, 'outbox-cap', {
        nextAttemptAt: new Date(FIXED_NOW.getTime() + 3600 * 1000),
        maxAttempts: 5,
      });
    });

    it('swallows markRetry rejection: the batch still resolves and counts the event as failed', async () => {
      const failingEvent = event({ outboxEventId: 'outbox-retry-fails', attempts: 1 });
      const consumer = fakeConsumer({
        process: vi.fn(async () => {
          throw new Error('process failed');
        }),
      });
      const outboxRepo = fakeOutboxRepo({
        claimPendingBatch: vi.fn(async () => [failingEvent]),
        markRetry: vi.fn(async () => {
          throw new Error('markRetry db error');
        }),
      });
      const logger = { warn: vi.fn(), error: vi.fn() };
      const { service } = buildService({ outboxRepo, consumers: [consumer], logger });

      await expect(service.processBatchOnce()).resolves.toEqual({ claimed: 1, processed: 0, failed: 1 });
      expect(outboxRepo.markRetry).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'outbox-relay markRetry failed',
        expect.objectContaining({ outboxEventId: 'outbox-retry-fails' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'outbox-relay event failed',
        expect.objectContaining({ outboxEventId: 'outbox-retry-fails', eventType: failingEvent.eventType }),
      );
    });
  });
});
