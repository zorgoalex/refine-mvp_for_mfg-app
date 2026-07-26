import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrmSourcePort } from './crm-sync.types';
import type { Bitrix24SyncConsumer, SyncIntent } from './bitrix24-sync-consumer';
import {
  runBackfill,
  type BackfillCheckpoint,
} from './crm-sync-backfill';

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

function makeConsumer(syncResult: SyncIntent[] | (() => SyncIntent[])): Bitrix24SyncConsumer {
  const fn = typeof syncResult === 'function' ? syncResult : () => syncResult;
  return {
    sync: vi.fn().mockImplementation(() => Promise.resolve(fn())),
    supports: vi.fn().mockReturnValue(true),
  } as unknown as Bitrix24SyncConsumer;
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
      } as unknown as Bitrix24SyncConsumer;

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
      } as unknown as Bitrix24SyncConsumer;

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
      } as unknown as Bitrix24SyncConsumer;

      const persist = makePersist();

      const result = await runBackfill({ source, consumer, persist, batchSize: 10, dryRun: false });

      expect(callOrder).toEqual(['client:1', 'client:2', 'order:10']);
      expect(result).toMatchObject({
        clients: 2,
        orders: 1,
        alreadyCompleted: false,
        checkpoint: { phase: 'completed' },
      });
    });
  });

  describe('empty consumer intents', () => {
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

      expect(result).toMatchObject({ clients: 1, orders: 1 });
      // Records and durable phase transitions all advance the checkpoint.
      expect(persist).toHaveBeenCalledTimes(4);
      persist.mock.calls.forEach((call) => {
        expect(call[0]).toEqual([]);
        expect(call[1]).toEqual(expect.objectContaining({ scope: 'all' }));
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
          bitrixObject: 'contact',
          bitrixId: '123',
          parentErpId: null,
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
      expect(result).toMatchObject({ clients: 1, orders: 1 });
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
      expect(result).toMatchObject({ clients: 3, orders: 2 });
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

  describe('scope and durable resume', () => {
    it('clients scope never lists or synchronizes orders', async () => {
      const listOrderIds = vi.fn().mockResolvedValue(['10']);
      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['1'])
          .mockResolvedValueOnce([]),
        listOrderIds,
      });
      const consumer = makeConsumer([]);
      const persist = makePersist();

      const result = await runBackfill({
        source,
        consumer,
        persist,
        batchSize: 10,
        dryRun: false,
        scope: 'clients',
      });

      expect(listOrderIds).not.toHaveBeenCalled();
      expect(
        (consumer.sync as ReturnType<typeof vi.fn>).mock.calls
          .map(([event]) => event.eventType),
      ).toEqual(['crm.sync.client.upsert']);
      expect(result).toMatchObject({
        clients: 1,
        orders: 0,
        checkpoint: { scope: 'clients', phase: 'completed', lastClientId: '1' },
      });
    });

    it('resumes clients after the last transactionally committed cursor', async () => {
      const checkpoint: BackfillCheckpoint = {
        scope: 'all',
        phase: 'clients',
        lastClientId: '20',
        lastOrderId: null,
        processedClients: 20,
        processedOrders: 0,
      };
      const listClientIds = vi.fn()
        .mockResolvedValueOnce(['21'])
        .mockResolvedValueOnce([]);
      const source = makeSource({
        listClientIds,
        listOrderIds: vi.fn().mockResolvedValue([]),
      });

      const result = await runBackfill({
        source,
        consumer: makeConsumer([]),
        persist: makePersist(),
        batchSize: 10,
        dryRun: false,
        checkpoint,
      });

      expect(listClientIds).toHaveBeenNthCalledWith(1, '20', 10);
      expect(result).toMatchObject({
        clients: 21,
        orders: 0,
        checkpoint: { phase: 'completed', lastClientId: '21' },
      });
    });

    it('resumes directly in orders without relisting clients', async () => {
      const checkpoint: BackfillCheckpoint = {
        scope: 'all',
        phase: 'orders',
        lastClientId: '20',
        lastOrderId: '99',
        processedClients: 20,
        processedOrders: 50,
      };
      const listClientIds = vi.fn().mockResolvedValue([]);
      const listOrderIds = vi.fn()
        .mockResolvedValueOnce(['100'])
        .mockResolvedValueOnce([]);
      const source = makeSource({ listClientIds, listOrderIds });

      const result = await runBackfill({
        source,
        consumer: makeConsumer([]),
        persist: makePersist(),
        batchSize: 10,
        dryRun: false,
        checkpoint,
      });

      expect(listClientIds).not.toHaveBeenCalled();
      expect(listOrderIds).toHaveBeenNthCalledWith(1, '99', 10);
      expect(result).toMatchObject({
        clients: 20,
        orders: 51,
        checkpoint: { phase: 'completed', lastOrderId: '100' },
      });
    });

    it('does not publish progress or advance the input cursor when persistence fails', async () => {
      const checkpoint: BackfillCheckpoint = {
        scope: 'clients',
        phase: 'clients',
        lastClientId: '4',
        lastOrderId: null,
        processedClients: 4,
        processedOrders: 0,
      };
      const source = makeSource({
        listClientIds: vi.fn().mockResolvedValueOnce(['5']),
      });
      const persist = vi.fn().mockRejectedValue(new Error('commit failed'));
      const onProgress = vi.fn();

      await expect(runBackfill({
        source,
        consumer: makeConsumer([]),
        persist,
        batchSize: 10,
        dryRun: false,
        scope: 'clients',
        checkpoint,
        onProgress,
      })).rejects.toThrow('commit failed');

      expect(persist).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ lastClientId: '5', processedClients: 5 }),
      );
      expect(onProgress).not.toHaveBeenCalled();
      expect(checkpoint).toEqual(expect.objectContaining({
        lastClientId: '4',
        processedClients: 4,
      }));
    });

    it('treats a completed checkpoint as a no-op until restart', async () => {
      const checkpoint: BackfillCheckpoint = {
        scope: 'all',
        phase: 'completed',
        lastClientId: '20',
        lastOrderId: '100',
        processedClients: 20,
        processedOrders: 50,
      };
      const source = makeSource();
      const consumer = makeConsumer([]);
      const persist = makePersist();

      const result = await runBackfill({
        source,
        consumer,
        persist,
        batchSize: 10,
        dryRun: false,
        checkpoint,
      });

      expect(result).toEqual({
        clients: 20,
        orders: 50,
        checkpoint,
        alreadyCompleted: true,
        interrupted: false,
      });
      expect(source.listClientIds).not.toHaveBeenCalled();
      expect(source.listOrderIds).not.toHaveBeenCalled();
      expect(consumer.sync).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });

    it('dry-run ignores a stored cursor and never persists checkpoints', async () => {
      const checkpoint: BackfillCheckpoint = {
        scope: 'clients',
        phase: 'completed',
        lastClientId: '99',
        lastOrderId: null,
        processedClients: 99,
        processedOrders: 0,
      };
      const listClientIds = vi.fn()
        .mockResolvedValueOnce(['1'])
        .mockResolvedValueOnce([]);
      const source = makeSource({ listClientIds });
      const persist = makePersist();

      const result = await runBackfill({
        source,
        consumer: makeConsumer([]),
        persist,
        batchSize: 10,
        dryRun: true,
        scope: 'clients',
        checkpoint,
      });

      expect(listClientIds).toHaveBeenNthCalledWith(1, '0', 10);
      expect(persist).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        clients: 1,
        checkpoint: { phase: 'completed', lastClientId: '1' },
        alreadyCompleted: false,
      });
    });

    it('reports only successfully persisted cursors as committed progress', async () => {
      const source = makeSource({
        listClientIds: vi.fn()
          .mockResolvedValueOnce(['1'])
          .mockResolvedValueOnce([]),
      });
      const calls: string[] = [];

      await runBackfill({
        source,
        consumer: makeConsumer([]),
        persist: vi.fn().mockImplementation(async (_intents, checkpoint) => {
          calls.push(`persist:${checkpoint.phase}:${checkpoint.lastClientId}`);
        }),
        batchSize: 10,
        dryRun: false,
        scope: 'clients',
        onProgress: (progress) => {
          calls.push(
            `progress:${progress.kind}:${progress.checkpoint.lastClientId}:${progress.committed}`,
          );
        },
      });

      expect(calls).toEqual([
        'persist:clients:1',
        'progress:record:1:true',
        'persist:completed:1',
        'progress:completed:1:true',
      ]);
    });

    it('finishes the current record then stops before taking the next one', async () => {
      let stop = false;
      const source = makeSource({
        listClientIds: vi.fn().mockResolvedValueOnce(['1', '2']),
      });
      const consumer = makeConsumer([]);
      const persist = vi.fn().mockImplementation(async () => {
        stop = true;
      });

      const result = await runBackfill({
        source,
        consumer,
        persist,
        batchSize: 10,
        dryRun: false,
        scope: 'clients',
        shouldStop: () => stop,
      });

      expect(consumer.sync).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        clients: 1,
        interrupted: true,
        checkpoint: { phase: 'clients', lastClientId: '1' },
      });
    });
  });
});
