import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrmSourcePort } from './crm-sync.types';
import type { TwentySyncConsumer, SyncIntent } from './twenty-sync-consumer';
import { runBackfill } from './crm-sync-backfill';

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function makeSource(overrides?: Partial<CrmSourcePort>): CrmSourcePort {
  return {
    getClientById: vi.fn().mockResolvedValue(null),
    getOrderById: vi.fn().mockResolvedValue(null),
    listClientIds: vi.fn().mockResolvedValue([]),
    listOrderIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as CrmSourcePort;
}

function makeConsumer(syncResult: SyncIntent[] | (() => SyncIntent[])): TwentySyncConsumer {
  const fn = typeof syncResult === 'function' ? syncResult : () => syncResult;
  return {
    sync: vi.fn().mockImplementation(() => Promise.resolve(fn())),
    supports: vi.fn().mockReturnValue(true),
  } as unknown as TwentySyncConsumer;
}

function makePersist(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(undefined);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runBackfill', () => {
  describe('synthEvent shape', () => {
    it('produces valid OutboxEventRecords for client and order entities', async () => {
      // We'll capture the events passed to consumer.sync
      const capturedEvents: ReturnType<typeof Object.assign>[] = [];

      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['c-1'])
          .mockResolvedValueOnce([]),
        listOrderIds: vi.fn()
          .mockResolvedValueOnce(['o-1'])
          .mockResolvedValueOnce([]),
      });

      const consumer = {
        sync: vi.fn().mockImplementation((event: unknown) => {
          capturedEvents.push(event);
          return Promise.resolve([]);
        }),
        supports: vi.fn().mockReturnValue(true),
      } as unknown as TwentySyncConsumer;

      await runBackfill({
        source,
        consumer,
        persist: makePersist(),
        batchSize: 10,
        dryRun: true,
      });

      expect(capturedEvents).toHaveLength(2);

      const clientEvent = capturedEvents[0];
      expect(typeof clientEvent.outboxEventId).toBe('string');
      expect(clientEvent.outboxEventId).not.toBe('');
      expect(UUID_RE.test(clientEvent.outboxEventId)).toBe(true);
      expect(clientEvent.eventType).toBe('crm.sync.client.upsert');
      expect(clientEvent.aggregateType).toBe('crm_sync');
      expect(clientEvent.aggregateId).toBe('c-1');
      expect(clientEvent.payload).toEqual({ entity: 'client', id: 'c-1', op: 'upsert' });
      expect(clientEvent.attempts).toBe(0);

      const orderEvent = capturedEvents[1];
      expect(typeof orderEvent.outboxEventId).toBe('string');
      expect(orderEvent.outboxEventId).not.toBe('');
      expect(UUID_RE.test(orderEvent.outboxEventId)).toBe(true);
      expect(orderEvent.eventType).toBe('crm.sync.order.upsert');
      expect(orderEvent.aggregateType).toBe('crm_sync');
      expect(orderEvent.aggregateId).toBe('o-1');
      expect(orderEvent.payload).toEqual({ entity: 'order', id: 'o-1', op: 'upsert' });
      expect(orderEvent.attempts).toBe(0);
    });

    it('each synthEvent has a unique outboxEventId (no UUID reuse across records)', async () => {
      const capturedIds: string[] = [];

      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['c-1', 'c-2'])
          .mockResolvedValueOnce([]),
        listOrderIds: vi.fn().mockResolvedValue([]),
      });

      const consumer = {
        sync: vi.fn().mockImplementation((event: { outboxEventId: string }) => {
          capturedIds.push(event.outboxEventId);
          return Promise.resolve([]);
        }),
        supports: vi.fn(),
      } as unknown as TwentySyncConsumer;

      await runBackfill({ source, consumer, persist: makePersist(), batchSize: 10, dryRun: true });

      expect(capturedIds).toHaveLength(2);
      expect(new Set(capturedIds).size).toBe(2);
    });
  });

  describe('ordering: clients before orders', () => {
    it('processes all clients before any order', async () => {
      const callOrder: string[] = [];

      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['1', '2'])
          .mockResolvedValueOnce([]),
        listOrderIds: vi.fn()
          .mockResolvedValueOnce(['10'])
          .mockResolvedValueOnce([]),
      });

      const consumer = {
        sync: vi.fn().mockImplementation((event: { aggregateId: string; eventType: string }) => {
          callOrder.push(event.eventType.includes('client') ? `client:${event.aggregateId}` : `order:${event.aggregateId}`);
          return Promise.resolve([{} as SyncIntent]);
        }),
        supports: vi.fn(),
      } as unknown as TwentySyncConsumer;

      const persist = makePersist();

      const result = await runBackfill({ source, consumer, persist, batchSize: 10, dryRun: false });

      expect(callOrder).toEqual(['client:1', 'client:2', 'order:10']);
      expect(result).toEqual({ clients: 2, orders: 1 });
    });
  });

  describe('idempotent re-run (hash no-op)', () => {
    it('consumer returning [] does not cause errors and counts still increment', async () => {
      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['c-1'])
          .mockResolvedValueOnce([]),
        listOrderIds: vi.fn()
          .mockResolvedValueOnce(['o-1'])
          .mockResolvedValueOnce([]),
      });

      const consumer = makeConsumer([]); // hash no-op: always []
      const persist = makePersist();

      const result = await runBackfill({ source, consumer, persist, batchSize: 10, dryRun: false });

      expect(result).toEqual({ clients: 1, orders: 1 });
      // persist was still called (with []) — no errors
      expect(persist).toHaveBeenCalledTimes(2);
      persist.mock.calls.forEach((call) => {
        expect(call[0]).toEqual([]);
      });
    });
  });

  describe('dryRun=true', () => {
    it('never calls persist when dryRun is true', async () => {
      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['c-1'])
          .mockResolvedValueOnce([]),
        listOrderIds: vi.fn()
          .mockResolvedValueOnce(['o-1'])
          .mockResolvedValueOnce([]),
      });

      const mockIntent: SyncIntent = {
        mapping: {
          entityType: 'client',
          erpId: 'c-1',
          twentyObject: 'companies',
          twentyId: 'twenty-123',
          status: 'active',
          lastHash: 'abc',
        },
        audit: {
          event: 'crm_sync.upsert',
          entityType: 'client',
          entityId: 'c-1',
          requestId: 'req-1',
          source: 'crm-sync',
          actorUserId: null,
        },
      };

      const consumer = makeConsumer([mockIntent]);
      const persist = makePersist();

      const result = await runBackfill({ source, consumer, persist, batchSize: 10, dryRun: true });

      expect(persist).not.toHaveBeenCalled();
      // consumer.sync must still be called (so we can see what would happen)
      expect(consumer.sync).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ clients: 1, orders: 1 });
    });

    it('counts increment in dryRun even when consumer returns empty intents', async () => {
      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['c-1', 'c-2', 'c-3'])
          .mockResolvedValueOnce([]),
        listOrderIds: vi.fn()
          .mockResolvedValueOnce(['o-1', 'o-2'])
          .mockResolvedValueOnce([]),
      });

      const consumer = makeConsumer([]);
      const persist = makePersist();

      const result = await runBackfill({ source, consumer, persist, batchSize: 10, dryRun: true });

      expect(persist).not.toHaveBeenCalled();
      expect(result).toEqual({ clients: 3, orders: 2 });
    });
  });

  describe('pagination', () => {
    it('paginates using last id of previous page as cursor', async () => {
      const listClientIds = vi.fn()
        .mockResolvedValueOnce(['1', '2'])  // page 1: after='0'
        .mockResolvedValueOnce(['3'])        // page 2: after='2'
        .mockResolvedValueOnce([]);           // page 3: after='3' → done

      const source = makeSource({
        listClientIds,
        listOrderIds: vi.fn().mockResolvedValue([]),
      });
      const consumer = makeConsumer([]);

      const result = await runBackfill({ source, consumer, persist: makePersist(), batchSize: 2, dryRun: true });

      expect(result.clients).toBe(3);
      expect(listClientIds).toHaveBeenNthCalledWith(1, '0', 2);
      expect(listClientIds).toHaveBeenNthCalledWith(2, '2', 2);
      expect(listClientIds).toHaveBeenNthCalledWith(3, '3', 2);
    });
  });
});
