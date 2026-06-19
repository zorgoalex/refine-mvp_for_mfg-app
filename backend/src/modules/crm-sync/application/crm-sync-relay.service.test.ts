import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import type { ClaimedCrmSyncOutboxEvent } from '../adapters/pg-crm-sync-outbox-repository';
import type { SyncIntent } from './twenty-sync-consumer';
import { CrmSyncRelayService } from './crm-sync-relay.service';

// ─── Shared mock factories ────────────────────────────────────────────────────

const NOOP_AUDIT_EVENT = {
  event: 'crm_sync.upsert',
  entityType: 'client',
  entityId: '1',
  requestId: 'req-1',
  source: 'crm-sync',
  actorUserId: null,
} as const;

function makeClaimedEvent(overrides: Partial<ClaimedCrmSyncOutboxEvent> = {}): ClaimedCrmSyncOutboxEvent {
  return {
    outboxEventId: 'oe-1',
    eventType: 'crm.sync.client',
    aggregateType: 'client',
    aggregateId: '1',
    payload: { entity: 'client', id: '1', op: 'upsert' },
    attempts: 0,
    lockToken: 'lock-aaa',
    ...overrides,
  };
}

function makeMapping(entityType: string, erpId: string, twentyObject: string) {
  return {
    entityType,
    erpId,
    twentyObject,
    twentyId: 'twenty-1',
    status: 'active',
    lastHash: 'h1',
  };
}

function clientIntent(): SyncIntent {
  return { mapping: makeMapping('client', '1', 'companies'), audit: { ...NOOP_AUDIT_EVENT } };
}

function orderIntent(): SyncIntent {
  return {
    mapping: makeMapping('order', '42', 'erpOrders'),
    audit: { ...NOOP_AUDIT_EVENT, entityType: 'order', entityId: '42' },
  };
}

/**
 * Builds a fake DatabaseService.
 * The `txClient` is the DatabaseClient passed to the tx handler.
 * By default, transaction() calls the handler with txClient.
 */
function makeDb(txClient?: DatabaseClient) {
  const fakeTxClient: DatabaseClient = txClient ?? {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  const db = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    transaction: vi.fn().mockImplementation((handler: (c: DatabaseClient) => Promise<unknown>) =>
      handler(fakeTxClient),
    ),
    isConfigured: true,
  };
  return { db, fakeTxClient };
}

function makeOutboxRepo(overrides: Record<string, unknown> = {}) {
  return {
    claimBatch: vi.fn(),
    markProcessed: vi.fn(),
    markRetry: vi.fn(),
    peekPending: vi.fn(),
    ...overrides,
  };
}

function makeMappingRepo(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(),
    upsertSuccess: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeAudit() {
  return { record: vi.fn().mockResolvedValue('audit-id') };
}

function makeConsumer(intents: SyncIntent[]) {
  return { sync: vi.fn().mockResolvedValue(intents) };
}

function makeDryRunConsumer(intents: SyncIntent[] = []) {
  return { sync: vi.fn().mockResolvedValue(intents) };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    getFlags: vi.fn().mockReturnValue({
      enabled: true,
      relayOwner: 'in_process',
      dryRun: false,
      pollIntervalMs: 5000,
      batchSize: 10,
      maxAttempts: 5,
      workerId: 'worker-1',
      leaseMs: 300000,
      ...overrides,
    }),
    getTwenty: vi.fn().mockReturnValue({ baseUrl: null, apiKey: null }),
  };
}

function makeRelay(
  opts: {
    outboxRepo?: ReturnType<typeof makeOutboxRepo>;
    consumer?: ReturnType<typeof makeConsumer>;
    dryRunConsumer?: ReturnType<typeof makeDryRunConsumer>;
    mapping?: ReturnType<typeof makeMappingRepo>;
    audit?: ReturnType<typeof makeAudit>;
    db?: ReturnType<typeof makeDb>['db'];
    config?: ReturnType<typeof makeConfig>;
    logger?: unknown;
  } = {},
) {
  const config = opts.config ?? makeConfig();
  const { db } = opts.db ? { db: opts.db } : makeDb();
  return new CrmSyncRelayService({
    outboxRepo: (opts.outboxRepo ?? makeOutboxRepo()) as never,
    consumer: (opts.consumer ?? makeConsumer([])) as never,
    dryRunConsumer: (opts.dryRunConsumer ?? makeDryRunConsumer()) as never,
    mapping: (opts.mapping ?? makeMappingRepo()) as never,
    audit: (opts.audit ?? makeAudit()) as never,
    db: db as never,
    config: config as never,
    logger: (opts.logger as never) ?? { log: vi.fn(), error: vi.fn() },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CrmSyncRelayService', () => {
  // ── (a) consumer returns [clientIntent, orderIntent], markProcessed → 1 ──────
  describe('(a) two intents, markProcessed=1', () => {
    it('calls consumer.sync BEFORE the tx, then markProcessed FIRST inside tx, then both intents in order', async () => {
      const event = makeClaimedEvent();
      const outboxRepo = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event]),
        markProcessed: vi.fn().mockResolvedValue(1),
      });
      const intents = [clientIntent(), orderIntent()];
      const consumer = makeConsumer(intents);
      const dryRunConsumer = makeDryRunConsumer();
      const mapping = makeMappingRepo();
      const audit = makeAudit();

      const callOrder: string[] = [];
      consumer.sync = vi.fn().mockImplementation(async () => {
        callOrder.push('consumer.sync');
        return intents;
      });

      const { db, fakeTxClient } = makeDb();
      (outboxRepo.markProcessed as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('markProcessed');
        return 1;
      });
      (mapping.upsertSuccess as ReturnType<typeof vi.fn>).mockImplementation(async (_c: unknown, m: { entityType: string }) => {
        callOrder.push(`upsertSuccess:${m.entityType}`);
      });
      (audit.record as ReturnType<typeof vi.fn>).mockImplementation(async (_c: unknown, e: { entityType: string }) => {
        callOrder.push(`audit.record:${e.entityType}`);
        return 'aid';
      });

      // Make the tx handler use fakeTxClient
      db.transaction = vi.fn().mockImplementation((handler: (c: DatabaseClient) => Promise<unknown>) =>
        handler(fakeTxClient),
      );

      const relay = makeRelay({ outboxRepo, consumer, dryRunConsumer, mapping, audit, db });
      const result = await relay.runTick();

      // consumer.sync must happen BEFORE the tx (before markProcessed)
      expect(callOrder[0]).toBe('consumer.sync');
      expect(callOrder[1]).toBe('markProcessed');
      // Both intents persisted in order after markProcessed
      expect(callOrder).toContain('upsertSuccess:client');
      expect(callOrder).toContain('upsertSuccess:order');
      expect(callOrder).toContain('audit.record:client');
      expect(callOrder).toContain('audit.record:order');
      // client intent before order intent
      expect(callOrder.indexOf('upsertSuccess:client')).toBeLessThan(
        callOrder.indexOf('upsertSuccess:order'),
      );

      expect(result).toEqual({ claimed: 1, processed: 1, failed: 0 });

      // Verify markProcessed was called with correct args (inside tx client)
      expect(outboxRepo.markProcessed).toHaveBeenCalledWith(
        fakeTxClient,
        event.outboxEventId,
        event.lockToken,
      );
      // upsertSuccess called with tx client
      expect(mapping.upsertSuccess).toHaveBeenCalledWith(fakeTxClient, intents[0].mapping);
      expect(mapping.upsertSuccess).toHaveBeenCalledWith(fakeTxClient, intents[1].mapping);
    });
  });

  // ── (a2) markProcessed → 0 (reclaimed): NO side effects ─────────────────────
  describe('(a2) two intents but markProcessed=0 (reclaimed)', () => {
    it('does NOT call upsertSuccess or audit.record when markProcessed returns 0', async () => {
      const event = makeClaimedEvent();
      const outboxRepo = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event]),
        markProcessed: vi.fn().mockResolvedValue(0),
      });
      const intents = [clientIntent(), orderIntent()];
      const consumer = makeConsumer(intents);
      const mapping = makeMappingRepo();
      const audit = makeAudit();

      // The tx handler is called; markProcessed returns 0 → OwnershipLost is thrown
      // → tx rolls back → upsertSuccess and audit.record must NOT be called
      const { db } = makeDb();
      db.transaction = vi.fn().mockImplementation(async (handler: (c: DatabaseClient) => Promise<unknown>) => {
        const fakeTx: DatabaseClient = { query: vi.fn() };
        // The handler will throw OwnershipLost, which transaction() propagates
        await handler(fakeTx);
      });

      const relay = makeRelay({ outboxRepo, consumer, mapping, audit, db });
      const result = await relay.runTick();

      expect(mapping.upsertSuccess).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      // Not counted as processed or failed — silently skipped
      expect(result).toEqual({ claimed: 1, processed: 0, failed: 0 });
    });
  });

  // ── (b) consumer returns [], markProcessed → 1 ───────────────────────────────
  describe('(b) empty intents, markProcessed=1', () => {
    it('calls only markProcessed, no upsertSuccess or audit.record', async () => {
      const event = makeClaimedEvent();
      const outboxRepo = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event]),
        markProcessed: vi.fn().mockResolvedValue(1),
      });
      const consumer = makeConsumer([]);
      const mapping = makeMappingRepo();
      const audit = makeAudit();
      const { db, fakeTxClient } = makeDb();
      db.transaction = vi.fn().mockImplementation((handler: (c: DatabaseClient) => Promise<unknown>) =>
        handler(fakeTxClient),
      );

      const relay = makeRelay({ outboxRepo, consumer, mapping, audit, db });
      const result = await relay.runTick();

      expect(outboxRepo.markProcessed).toHaveBeenCalledWith(
        fakeTxClient,
        event.outboxEventId,
        event.lockToken,
      );
      expect(mapping.upsertSuccess).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(result).toEqual({ claimed: 1, processed: 1, failed: 0 });
    });
  });

  // ── (c) consumer throws, markRetry → 1: markFailed called ───────────────────
  describe('(c) consumer throws, markRetry=1', () => {
    it('calls markRetry then markFailed', async () => {
      const event = makeClaimedEvent();
      const outboxRepo = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event]),
        markRetry: vi.fn().mockResolvedValue(1),
      });
      const consumer = { sync: vi.fn().mockRejectedValue(new Error('Twenty API down')) };
      const mapping = makeMappingRepo();
      const { db } = makeDb();

      const relay = makeRelay({ outboxRepo, consumer, mapping, db });
      const result = await relay.runTick();

      expect(outboxRepo.markRetry).toHaveBeenCalledWith(
        db,
        event.outboxEventId,
        event.lockToken,
        expect.any(String), // nextAttemptAt ISO string
        expect.any(Number), // maxAttempts
      );
      expect(mapping.markFailed).toHaveBeenCalledWith(
        db,
        'client',
        '1',
        'companies',
        'Twenty API down',
      );
      expect(result).toEqual({ claimed: 1, processed: 0, failed: 1 });
    });
  });

  // ── (c2) consumer throws, markRetry → 0: markFailed NOT called ───────────────
  describe('(c2) consumer throws, markRetry=0 (reclaimed)', () => {
    it('does NOT call markFailed when markRetry returns 0', async () => {
      const event = makeClaimedEvent();
      const outboxRepo = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event]),
        markRetry: vi.fn().mockResolvedValue(0),
      });
      const consumer = { sync: vi.fn().mockRejectedValue(new Error('error')) };
      const mapping = makeMappingRepo();
      const { db } = makeDb();

      const relay = makeRelay({ outboxRepo, consumer, mapping, db });
      const result = await relay.runTick();

      expect(mapping.markFailed).not.toHaveBeenCalled();
      // Not counted as a failure either (we didn't own the row)
      expect(result).toEqual({ claimed: 1, processed: 0, failed: 0 });
    });
  });

  // ── (d) dryRun=true: uses peekPending + dryRunConsumer, zero DB/Twenty writes ─
  describe('(d) runTick({dryRun:true})', () => {
    it('uses peekPending (NOT claimBatch), calls dryRunConsumer, no markProcessed/markRetry/tx', async () => {
      const pendingEvent: OutboxEventRecord = {
        outboxEventId: 'oe-dry',
        eventType: 'crm.sync.client',
        aggregateType: 'client',
        aggregateId: '2',
        payload: { entity: 'client', id: '2', op: 'upsert' },
        attempts: 0,
      };
      const outboxRepo = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([]),
        peekPending: vi.fn().mockResolvedValue([pendingEvent]),
        markProcessed: vi.fn(),
        markRetry: vi.fn(),
      });
      const realConsumer = { sync: vi.fn().mockResolvedValue([clientIntent()]) };
      const dryRunConsumer = { sync: vi.fn().mockResolvedValue([clientIntent()]) };
      const mapping = makeMappingRepo();
      const audit = makeAudit();
      const { db } = makeDb();

      // flags.dryRun is FALSE — dryRun path is forced by opts.dryRun=true
      const config = makeConfig({ dryRun: false });
      const relay = makeRelay({ outboxRepo, consumer: realConsumer, dryRunConsumer, mapping, audit, db, config });

      const result = await relay.runTick({ dryRun: true });

      // peekPending used, claimBatch NOT used
      expect(outboxRepo.peekPending).toHaveBeenCalled();
      expect(outboxRepo.claimBatch).not.toHaveBeenCalled();

      // dryRunConsumer used, real consumer NOT used
      expect(dryRunConsumer.sync).toHaveBeenCalledWith(pendingEvent);
      expect(realConsumer.sync).not.toHaveBeenCalled();

      // No claim, no tx writes, no mapping/audit writes
      expect(outboxRepo.markProcessed).not.toHaveBeenCalled();
      expect(outboxRepo.markRetry).not.toHaveBeenCalled();
      expect(mapping.upsertSuccess).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();

      // claimed reflects peekPending count; processed/failed stay 0
      expect(result).toEqual({ claimed: 1, processed: 0, failed: 0 });
    });
  });

  // ── (e) stale processing row reclaimed: OLD token → 0 rows → no side effects ─
  describe('(e) stale lock_token (row reclaimed by another worker)', () => {
    it('markProcessed=0 → no upsertSuccess/audit.record; markRetry=0 → no markFailed', async () => {
      // Success-path: reclaimed before markProcessed
      const event = makeClaimedEvent({ lockToken: 'stale-lock' });
      const outboxRepoSuccess = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event]),
        markProcessed: vi.fn().mockResolvedValue(0),
      });
      const intents = [clientIntent()];
      const consumerSuccess = makeConsumer(intents);
      const mappingSuccess = makeMappingRepo();
      const auditSuccess = makeAudit();
      const { db: dbSuccess, fakeTxClient: fakeTxSuccess } = makeDb();
      dbSuccess.transaction = vi.fn().mockImplementation(
        async (handler: (c: DatabaseClient) => Promise<unknown>) => {
          await handler(fakeTxSuccess);
        },
      );

      const relaySuccess = makeRelay({
        outboxRepo: outboxRepoSuccess,
        consumer: consumerSuccess,
        mapping: mappingSuccess,
        audit: auditSuccess,
        db: dbSuccess,
      });
      await relaySuccess.runTick();
      expect(mappingSuccess.upsertSuccess).not.toHaveBeenCalled();
      expect(auditSuccess.record).not.toHaveBeenCalled();

      // Error-path: reclaimed before markRetry
      const event2 = makeClaimedEvent({ lockToken: 'stale-lock-2' });
      const outboxRepoError = makeOutboxRepo({
        claimBatch: vi.fn().mockResolvedValue([event2]),
        markRetry: vi.fn().mockResolvedValue(0),
      });
      const consumerError = { sync: vi.fn().mockRejectedValue(new Error('api error')) };
      const mappingError = makeMappingRepo();
      const { db: dbError } = makeDb();

      const relayError = makeRelay({
        outboxRepo: outboxRepoError,
        consumer: consumerError,
        mapping: mappingError,
        db: dbError,
      });
      await relayError.runTick();
      expect(mappingError.markFailed).not.toHaveBeenCalled();
    });
  });
});

// ─── (f) Scheduler non-reentrant test ─────────────────────────────────────────

describe('CrmSyncRelaySchedulerService — non-reentrant', () => {
  it('skips the second tick if the first is still in-flight', async () => {
    // Dynamically import to avoid circular dep issues
    const { CrmSyncRelaySchedulerService } = await import('./crm-sync-relay-scheduler.service');

    let resolveFirstTick!: () => void;
    const firstTickInflight = new Promise<void>((res) => {
      resolveFirstTick = res;
    });

    const relay = {
      runTick: vi
        .fn()
        .mockImplementationOnce(() => firstTickInflight) // first tick hangs
        .mockResolvedValue({ claimed: 0, processed: 0, failed: 0 }),
    };

    const config = {
      getFlags: vi.fn().mockReturnValue({
        enabled: true,
        relayOwner: 'in_process',
        dryRun: false,
        pollIntervalMs: 5000,
        batchSize: 10,
        maxAttempts: 5,
        workerId: 'w1',
        leaseMs: 300000,
      }),
    };

    const logger = { log: vi.fn(), error: vi.fn() };
    const scheduler = new CrmSyncRelaySchedulerService(
      relay as never,
      config as never,
      logger,
    );

    // Fire first tick (does not await — it hangs on firstTickInflight)
    const tick1 = scheduler.tick();

    // Immediately fire a second tick — should be skipped because running=true
    await scheduler.tick();

    // Relay.runTick should have been called only once (the second was skipped)
    expect(relay.runTick).toHaveBeenCalledTimes(1);

    // Now resolve the first tick and wait for it to finish
    resolveFirstTick();
    await tick1;

    // After the first tick completes, running=false — a third tick should proceed
    await scheduler.tick();
    expect(relay.runTick).toHaveBeenCalledTimes(2);
  });
});
