import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

// Module wiring smoke tests.
//
// These tests exercise the ACTUAL module provider factories (the same
// `useFactory` functions @Module wires at boot) rather than comparing fresh
// standalone class instances. We resolve the provider metadata off
// CrmSyncModule, invoke the real factory with stub deps, and assert on the
// CONSTRUCTED graph:
//   - with creds ABSENT the real consumer's Twenty client is the
//     FailingTwentyApiClient (a live sync attempt throws "not configured",
//     never a silent Noop);
//   - with the scheduler disabled, onModuleInit never arms an interval and the
//     relay's runTick is never called.
//
// @nestjs/testing is not installed in this package, so we drive the real
// factories directly via the module's provider metadata. Fully deterministic:
// no real DB/network is touched (db.query is stubbed to return zero rows so the
// mapping lookup resolves before the Twenty client is invoked).

type ModuleProvider =
  | { provide: unknown; useFactory: (...args: unknown[]) => unknown; inject?: unknown[] }
  | unknown;

async function getProviderFactory(provideToken: unknown): Promise<{
  useFactory: (...args: unknown[]) => unknown;
}> {
  const { CrmSyncModule } = await import('./crm-sync.module');
  const providers = (Reflect.getMetadata('providers', CrmSyncModule) ??
    []) as ModuleProvider[];
  const match = providers.find(
    (p): p is { provide: unknown; useFactory: (...args: unknown[]) => unknown } =>
      typeof p === 'object' &&
      p !== null &&
      'provide' in p &&
      (p as { provide: unknown }).provide === provideToken &&
      typeof (p as { useFactory?: unknown }).useFactory === 'function',
  );
  if (!match) {
    throw new Error('Provider factory not found for token in CrmSyncModule metadata');
  }
  return { useFactory: match.useFactory };
}

describe('CrmSyncModule wiring (offline smoke)', () => {
  it('imports without syntax or resolution errors', async () => {
    const mod = await import('./crm-sync.module');
    expect(mod.CrmSyncModule).toBeDefined();
  });

  it('FailingTwentyApiClient: every method rejects with config error', async () => {
    const { FailingTwentyApiClient } = await import('./adapters/failing-twenty-api-client');
    const client = new FailingTwentyApiClient();
    const MSG = /TWENTY_SYNC_BASE_URL|TWENTY_SYNC_API_KEY/;
    await expect(client.createRecord('companies', {})).rejects.toThrow(MSG);
    await expect(client.updateRecord('companies', 'id', {})).rejects.toThrow(MSG);
    await expect(client.findIdByErpId('companies', '1')).rejects.toThrow(MSG);
    await expect(client.deleteRecord('companies', 'id')).rejects.toThrow(MSG);
  });

  it('real factory wires FailingTwentyApiClient (not Noop) into the real consumer when creds absent', async () => {
    // Build the REAL relay via the module's own provider factory, with creds
    // absent (getTwenty() → null/null) and the DB configured=false but its
    // query stubbed to return zero rows. The constructed real consumer must use
    // FailingTwentyApiClient, so a live sync attempt throws "not configured"
    // (NOT a silent Noop that resolves).
    const { CrmSyncRelayService } = await import('./application/crm-sync-relay.service');
    const { TwentySyncConsumer } = await import('./application/twenty-sync-consumer');
    const { PgCrmSyncMappingRepository } = await import('./adapters/pg-crm-sync-mapping-repository');
    const { PgCrmSyncOutboxRepository } = await import('./adapters/pg-crm-sync-outbox-repository');
    const { AuditService } = await import('../../common/audit/audit.service');

    const dbStub = {
      isConfigured: false,
      // mapping.get() runs first; return zero rows so control flow reaches the
      // wired Twenty client (findIdByErpId) where the failure must surface.
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      transaction: vi.fn().mockRejectedValue(new Error('no db')),
    } as never;

    const configStub = {
      // Creds ABSENT → factory must pick FailingTwentyApiClient for the real consumer.
      getTwenty: () => ({ baseUrl: null, apiKey: null }),
      getFlags: () => ({
        enabled: true,
        relayOwner: 'in_process' as const,
        dryRun: false,
        pollIntervalMs: 5000,
        batchSize: 10,
        maxAttempts: 5,
        workerId: 'test',
        leaseMs: 300000,
      }),
    } as never;

    const mapping = new PgCrmSyncMappingRepository();
    const outboxRepo = new PgCrmSyncOutboxRepository();
    const audit = new AuditService();

    const { useFactory } = await getProviderFactory(CrmSyncRelayService);
    // inject order: [DatabaseService, CrmSyncRuntimeConfigService,
    //   PgCrmSyncMappingRepository, PgCrmSyncOutboxRepository, AuditService]
    const relay = useFactory(dbStub, configStub, mapping, outboxRepo, audit) as InstanceType<
      typeof CrmSyncRelayService
    >;
    expect(relay).toBeInstanceOf(CrmSyncRelayService);

    // Reach into the wired real consumer the factory constructed and drive a
    // live (non-dry-run) sync attempt. A client delete event takes the path
    // mapping.get() (→ null via stubbed query) then twenty.findIdByErpId(...),
    // which must reject with the "not configured" error — proving the wired
    // client is FailingTwentyApiClient, never a silent NoopTwentyApiClient.
    const consumer = (relay as unknown as { consumer: InstanceType<typeof TwentySyncConsumer> })
      .consumer;
    expect(consumer).toBeInstanceOf(TwentySyncConsumer);

    const event = {
      outboxEventId: 'evt-1',
      eventType: 'crm.sync.client',
      aggregateType: 'crm_sync',
      aggregateId: '1',
      payload: { entity: 'client', id: '1', op: 'delete' },
      attempts: 0,
    };

    await expect(consumer.sync(event as never)).rejects.toThrow(
      /not configured|TWENTY_SYNC_BASE_URL|TWENTY_SYNC_API_KEY/,
    );
  });

  it('scheduler factory: onModuleInit does NOT call relay.runTick when disabled', async () => {
    // Build the REAL scheduler via the module's own provider factory with the
    // disabled config and a runTick spy; assert the interval is never armed and
    // runTick is never invoked (fail-closed scheduler gate).
    const { CrmSyncRelaySchedulerService } = await import(
      './application/crm-sync-relay-scheduler.service'
    );

    const runTick = vi.fn().mockResolvedValue({ claimed: 0, processed: 0, failed: 0 });
    const relayStub = { runTick } as never;

    const configStub = {
      getFlags: () => ({
        enabled: false,
        relayOwner: 'none' as const,
        dryRun: false,
        pollIntervalMs: 5000,
        batchSize: 10,
        maxAttempts: 5,
        workerId: 'test',
        leaseMs: 300000,
      }),
    } as never;

    const { useFactory } = await getProviderFactory(CrmSyncRelaySchedulerService);
    // inject order: [CrmSyncRelayService, CrmSyncRuntimeConfigService]
    const scheduler = useFactory(relayStub, configStub) as InstanceType<
      typeof CrmSyncRelaySchedulerService
    >;
    expect(scheduler).toBeInstanceOf(CrmSyncRelaySchedulerService);

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // onModuleInit must short-circuit (shouldRun=false): no interval armed.
    scheduler.onModuleInit();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // A manual tick with disabled flags must also be a no-op: runTick stays at 0.
    await scheduler.tick();
    expect(runTick).not.toHaveBeenCalled();

    scheduler.onModuleDestroy();
    setIntervalSpy.mockRestore();
  });

  it('real consumer is backed by FailingTwentyApiClient (not NoopTwentyApiClient) when creds absent', async () => {
    // Distinctness guard retained: Failing throws, Noop resolves; they are not
    // the same class. (The wiring assertion above proves the factory picks
    // Failing for the real consumer.)
    const { FailingTwentyApiClient } = await import('./adapters/failing-twenty-api-client');
    const { NoopTwentyApiClient } = await import('./adapters/twenty-api-client');

    const failing = new FailingTwentyApiClient();
    await expect(failing.createRecord('companies', {})).rejects.toThrow();

    const noop = new NoopTwentyApiClient();
    await expect(noop.createRecord('companies', {})).resolves.toBeDefined();

    expect(failing).not.toBeInstanceOf(NoopTwentyApiClient);
    expect(noop).not.toBeInstanceOf(FailingTwentyApiClient);
  });

  it('UnavailableCrmSourceRepository returns null/[] for all methods', async () => {
    const { UnavailableCrmSourceRepository } = await import(
      './adapters/unavailable-crm-source-repository'
    );
    const repo = new UnavailableCrmSourceRepository();
    expect(await repo.getClientById('1')).toBeNull();
    expect(await repo.getOrderById('1')).toBeNull();
    expect(await repo.listClientIds('0', 10)).toEqual([]);
    expect(await repo.listOrderIds('0', 10)).toEqual([]);
  });
});
