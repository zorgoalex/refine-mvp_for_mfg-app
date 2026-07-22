import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

type ModuleProvider =
  | { provide: unknown; useFactory: (...args: unknown[]) => unknown; inject?: unknown[] }
  | unknown;

async function getProviderFactory(provideToken: unknown): Promise<{
  useFactory: (...args: unknown[]) => unknown;
}> {
  const { CrmSyncModule } = await import('./crm-sync.module');
  const providers = (Reflect.getMetadata('providers', CrmSyncModule) ?? []) as ModuleProvider[];
  const match = providers.find(
    (provider): provider is {
      provide: unknown;
      useFactory: (...args: unknown[]) => unknown;
    } =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === provideToken &&
      typeof provider.useFactory === 'function',
  );
  if (!match) throw new Error('Provider factory not found in CrmSyncModule');
  return match;
}

describe('CrmSyncModule Bitrix24 wiring', () => {
  it('imports without resolution errors', async () => {
    expect((await import('./crm-sync.module')).CrmSyncModule).toBeDefined();
  });

  it('FailingBitrix24ApiClient rejects every external operation', async () => {
    const { FailingBitrix24ApiClient } = await import(
      './adapters/failing-bitrix24-api-client'
    );
    const client = new FailingBitrix24ApiClient();
    const error = /BITRIX24_WEBHOOK_URL/;

    await expect(client.createCrmItem(3, {})).rejects.toThrow(error);
    await expect(client.updateCrmItem(3, '1', {})).rejects.toThrow(error);
    await expect(client.findCrmItemByOrigin(3, 'ERP_CLIENT_1')).rejects.toThrow(error);
    await expect(client.deleteCrmItem(3, '1')).rejects.toThrow(error);
    await expect(client.setDealProductRows('1', [])).rejects.toThrow(error);
    await expect(client.findPaymentByXmlId('ERP_PAYMENT_1')).rejects.toThrow(error);
    await expect(client.listDealPaymentIds('1')).rejects.toThrow(error);
    await expect(client.createDealPayment('1')).rejects.toThrow(error);
    await expect(client.updatePayment('1', {})).rejects.toThrow(error);
    await expect(client.deletePayment('1')).rejects.toThrow(error);
  });

  it('wires the failing client into the real consumer when webhook is absent', async () => {
    const { CrmSyncRelayService } = await import('./application/crm-sync-relay.service');
    const { Bitrix24SyncConsumer } = await import('./application/bitrix24-sync-consumer');
    const { PgCrmSyncMappingRepository } = await import(
      './adapters/pg-crm-sync-mapping-repository'
    );
    const { PgCrmSyncOutboxRepository } = await import(
      './adapters/pg-crm-sync-outbox-repository'
    );
    const { AuditService } = await import('../../common/audit/audit.service');
    const db = {
      isConfigured: false,
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      transaction: vi.fn(),
    } as never;
    const config = {
      getBitrix24: () => ({
        webhookUrl: null,
        requestTimeoutMs: 30000,
        currencyId: 'KZT',
        paySystemId: null,
        assignedById: null,
        erpBaseUrl: 'https://erp.example.com',
      }),
      getFlags: () => ({
        enabled: true,
        relayOwner: 'in_process',
        dryRun: false,
        pollIntervalMs: 5000,
        batchSize: 10,
        maxAttempts: 5,
        workerId: 'test',
        leaseMs: 300000,
      }),
    } as never;
    const { useFactory } = await getProviderFactory(CrmSyncRelayService);
    const relay = useFactory(
      db,
      config,
      new PgCrmSyncMappingRepository(),
      new PgCrmSyncOutboxRepository(),
      new AuditService(),
    ) as InstanceType<typeof CrmSyncRelayService>;
    const consumer = (relay as unknown as { consumer: InstanceType<typeof Bitrix24SyncConsumer> })
      .consumer;

    await expect(
      consumer.sync({
        outboxEventId: 'evt-1',
        eventType: 'crm.sync.client.delete',
        aggregateType: 'crm_sync',
        aggregateId: '1',
        payload: { entity: 'client', id: '1', op: 'delete' },
        attempts: 0,
      }),
    ).rejects.toThrow(/BITRIX24_WEBHOOK_URL/);
  });

  it('does not arm the scheduler when sync is disabled', async () => {
    const { CrmSyncRelaySchedulerService } = await import(
      './application/crm-sync-relay-scheduler.service'
    );
    const relay = {
      runTick: vi.fn().mockResolvedValue({ claimed: 0, processed: 0, failed: 0 }),
    } as never;
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
    } as never;
    const { useFactory } = await getProviderFactory(CrmSyncRelaySchedulerService);
    const scheduler = useFactory(relay, config) as InstanceType<
      typeof CrmSyncRelaySchedulerService
    >;
    const interval = vi.spyOn(globalThis, 'setInterval');

    scheduler.onModuleInit();
    await scheduler.tick();

    expect(interval).not.toHaveBeenCalled();
    expect(relay.runTick).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
    interval.mockRestore();
  });

  it('unavailable source returns empty values for every method', async () => {
    const { UnavailableCrmSourceRepository } = await import(
      './adapters/unavailable-crm-source-repository'
    );
    const source = new UnavailableCrmSourceRepository();

    expect(await source.getClientById('1')).toBeNull();
    expect(await source.getOrderById('1')).toBeNull();
    expect(await source.getPaymentsByOrderId('1')).toEqual([]);
    expect(await source.hasOrdersForClient('1')).toBe(false);
    expect(await source.listClientIds('0', 10)).toEqual([]);
    expect(await source.listOrderIds('0', 10)).toEqual([]);
  });
});
