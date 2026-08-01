import { describe, expect, it, vi } from 'vitest';
import { Bitrix24ReverseProcessorService } from './bitrix24-reverse-processor.service';

const event = {
  inboundEventId: '00000000-0000-4000-8000-000000000001',
  memberId: 'member-1',
  eventName: 'ONCRMCONTACTUPDATE',
  objectType: 'contact' as const,
  operation: 'upsert' as const,
  bitrixId: '42',
  attempts: 1,
  lockToken: 'lock-1',
};

function enabledConfig() {
  return {
    getReverseSync: () => ({
      enabled: true,
      relayOwner: 'in_process',
      dryRun: false,
      workerId: 'worker-1',
      batchSize: 25,
      leaseMs: 300_000,
      maxAttempts: 10,
      portalDomain: 'mebelkz.bitrix24.kz',
      portalTimezone: 'Asia/Almaty',
      actorUserId: 99,
      reconcileIntervalMs: 900_000,
    }),
  };
}

describe('Bitrix24ReverseProcessorService', () => {
  it('proves inbox ownership around OAuth reads and commits the event', async () => {
    const repository = {
      claimEvents: vi.fn().mockResolvedValue([event]),
      heartbeatEvent: vi.fn().mockResolvedValue(true),
      upsertClient: vi.fn().mockResolvedValue(17),
      markEventProcessed: vi.fn().mockResolvedValue(true),
      markEventFailed: vi.fn(),
    };
    const bitrix = {
      withRequestGuard: vi.fn(async (
        guard: () => Promise<void>,
        operation: () => Promise<unknown>,
      ) => {
        await guard();
        return operation();
      }),
      getCrmItem: vi.fn().mockResolvedValue({
        id: 42,
        name: 'Иван',
        updatedTime: '2026-07-30T10:00:00+03:00',
        fm: [],
      }),
    };
    const service = new Bitrix24ReverseProcessorService(
      repository as never,
      bitrix as never,
      enabledConfig() as never,
    );

    await expect(service.runTick()).resolves.toEqual({
      claimed: 1,
      processed: 1,
      failed: 0,
    });
    expect(repository.heartbeatEvent).toHaveBeenCalledTimes(3);
    expect(repository.upsertClient).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'contact',
        bitrixId: '42',
        name: 'Иван',
      }),
      event.inboundEventId,
      event.lockToken,
    );
    expect(repository.markEventProcessed).toHaveBeenCalledWith(event);
    expect(repository.markEventFailed).not.toHaveBeenCalled();
  });

  it('does not report a processed event after final ownership is lost', async () => {
    const repository = {
      claimEvents: vi.fn().mockResolvedValue([event]),
      heartbeatEvent: vi.fn().mockResolvedValue(true),
      upsertClient: vi.fn().mockResolvedValue(17),
      markEventProcessed: vi.fn().mockResolvedValue(false),
      markEventFailed: vi.fn(),
    };
    const bitrix = {
      withRequestGuard: async (
        guard: () => Promise<void>,
        operation: () => Promise<unknown>,
      ) => {
        await guard();
        return operation();
      },
      getCrmItem: vi.fn().mockResolvedValue({
        name: 'Иван',
        updatedTime: '2026-07-30T10:00:00+03:00',
        fm: [],
      }),
    };
    const service = new Bitrix24ReverseProcessorService(
      repository as never,
      bitrix as never,
      enabledConfig() as never,
    );

    await expect(service.runTick()).resolves.toEqual({
      claimed: 1,
      processed: 0,
      failed: 0,
    });
    expect(repository.markEventFailed).not.toHaveBeenCalled();
  });

  it('keeps workers dormant while reverse sync is disabled', async () => {
    const repository = {
      claimEvents: vi.fn(),
    };
    const config = {
      getReverseSync: () => ({
        enabled: false,
        relayOwner: 'none',
        dryRun: false,
      }),
    };
    const service = new Bitrix24ReverseProcessorService(
      repository as never,
      {} as never,
      config as never,
    );

    await expect(service.runTick()).resolves.toEqual({
      claimed: 0,
      processed: 0,
      failed: 0,
    });
    expect(repository.claimEvents).not.toHaveBeenCalled();
  });

  it('keeps a Deal unresolved until its exact counterparty mapping exists', async () => {
    const dealEvent = {
      ...event,
      eventName: 'ONCRMDEALUPDATE',
      objectType: 'deal' as const,
      bitrixId: '77',
    };
    const repository = {
      claimEvents: vi.fn().mockResolvedValue([dealEvent]),
      heartbeatEvent: vi.fn().mockResolvedValue(true),
      findMappingByErp: vi.fn().mockResolvedValue(null),
      findMappingByBitrix: vi.fn().mockResolvedValue(null),
      upsertClient: vi.fn(),
      upsertDeal: vi.fn().mockResolvedValue({ requestId: 12, erpOrderId: null }),
      replaceRequestPaymentSnapshots: vi.fn(),
      markEventProcessed: vi.fn().mockResolvedValue(true),
      markEventFailed: vi.fn(),
    };
    const bitrix = {
      withRequestGuard: vi.fn(async (
        guard: () => Promise<void>,
        operation: () => Promise<unknown>,
      ) => {
        await guard();
        return operation();
      }),
      getCrmItem: vi.fn().mockResolvedValue({
        id: 77,
        title: 'Новая заявка',
        contactId: 42,
        updatedTime: '2026-07-30T10:00:00+03:00',
        createdTime: '2026-07-30T09:00:00+03:00',
      }),
      listDealPaymentIds: vi.fn().mockResolvedValue([]),
    };
    const service = new Bitrix24ReverseProcessorService(
      repository as never,
      bitrix as never,
      enabledConfig() as never,
    );

    await expect(service.runTick()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(repository.findMappingByBitrix).toHaveBeenCalledWith('contact', '42');
    expect(repository.upsertClient).not.toHaveBeenCalled();
    expect(bitrix.getCrmItem).toHaveBeenCalledTimes(1);
    expect(repository.upsertDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        bitrixId: '77',
        clientId: null,
        counterpartyObjectType: 'contact',
        counterpartyBitrixId: '42',
      }),
      dealEvent.inboundEventId,
      dealEvent.lockToken,
      { actorUserId: 99 },
    );
  });
});
