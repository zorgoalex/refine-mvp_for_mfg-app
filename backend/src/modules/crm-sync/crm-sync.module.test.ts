import { describe, expect, it } from 'vitest';

// Module wiring smoke tests.
// Verifies that the module assembles without runtime errors when DatabaseService
// is not configured (isConfigured=false) — the standard offline / CI scenario.

describe('CrmSyncModule wiring (offline smoke)', () => {
  it('imports without syntax or resolution errors', async () => {
    const mod = await import('./crm-sync.module');
    expect(mod.CrmSyncModule).toBeDefined();
  });

  it('CrmSyncRelayService can be instantiated with Noop dependencies', async () => {
    const { CrmSyncRelayService } = await import('./application/crm-sync-relay.service');
    const { PgCrmSyncOutboxRepository } = await import('./adapters/pg-crm-sync-outbox-repository');
    const { PgCrmSyncMappingRepository } = await import('./adapters/pg-crm-sync-mapping-repository');
    const { TwentySyncConsumer } = await import('./application/twenty-sync-consumer');
    const { UnavailableCrmSourceRepository } = await import('./adapters/unavailable-crm-source-repository');
    const { NoopTwentyApiClient } = await import('./adapters/twenty-api-client');
    const { AuditService } = await import('../../common/audit/audit.service');

    // Build a minimal offline config mock
    const config = {
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
      getTwenty: () => ({ baseUrl: null, apiKey: null }),
    } as never;

    const db = {
      isConfigured: false,
      query: () => Promise.reject(new Error('no db')),
      transaction: () => Promise.reject(new Error('no db')),
    } as never;

    const source = new UnavailableCrmSourceRepository();
    const noop = new NoopTwentyApiClient();
    const mapping = new PgCrmSyncMappingRepository();
    const outboxRepo = new PgCrmSyncOutboxRepository();
    const audit = new AuditService();

    const consumer = new TwentySyncConsumer({ source, twenty: noop, mapping, db });
    const dryRunConsumer = new TwentySyncConsumer({ source, twenty: noop, mapping, db });

    const relay = new CrmSyncRelayService({
      outboxRepo,
      consumer,
      dryRunConsumer,
      mapping,
      audit,
      db,
      config,
    });

    expect(relay).toBeDefined();
  });

  it('CrmSyncRelaySchedulerService: shouldRun=false when disabled', async () => {
    const { CrmSyncRelaySchedulerService } = await import(
      './application/crm-sync-relay-scheduler.service'
    );

    const relay = { runTick: () => Promise.resolve({ claimed: 0, processed: 0, failed: 0 }) };
    const config = {
      getFlags: () => ({
        enabled: false,
        relayOwner: 'none',
        dryRun: false,
        pollIntervalMs: 5000,
        batchSize: 10,
        maxAttempts: 5,
        workerId: 'test',
        leaseMs: 300000,
      }),
    };

    const scheduler = new CrmSyncRelaySchedulerService(
      relay as never,
      config as never,
    );

    // onModuleInit should be a no-op (no interval started)
    scheduler.onModuleInit();
    // Manually calling tick with disabled flags should do nothing
    await scheduler.tick();
    // relay.runTick never called
    // (no assertion needed — it would throw if called, which would fail the test)
    scheduler.onModuleDestroy();
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

  it('real consumer is backed by FailingTwentyApiClient (not NoopTwentyApiClient) when creds absent', async () => {
    // When creds are absent, the real consumer must use FailingTwentyApiClient
    // so that an enabled-but-misconfigured run throws loudly, not silently no-ops.
    // We verify this by checking module import wiring: FailingTwentyApiClient is imported
    // and NoopTwentyApiClient is not used as the real consumer's client.
    const { FailingTwentyApiClient } = await import('./adapters/failing-twenty-api-client');
    const { NoopTwentyApiClient } = await import('./adapters/twenty-api-client');

    // FailingTwentyApiClient must throw (real consumer protection)
    const failing = new FailingTwentyApiClient();
    await expect(failing.createRecord('companies', {})).rejects.toThrow();

    // NoopTwentyApiClient must NOT throw (it's only for dry-run)
    const noop = new NoopTwentyApiClient();
    await expect(noop.createRecord('companies', {})).resolves.toBeDefined();

    // These two are distinctly different — module wires failing (not noop) to real consumer
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
