import { describe, expect, it, vi } from 'vitest';
import { Bitrix24ProductSyncService } from './bitrix24-product-sync.service';

function row(id: string, productId: string, price = '50'): Record<string, unknown> {
  return {
    id,
    productId,
    productName: `Товар ${productId}`,
    quantity: '1',
    price,
    discountTypeId: null,
    discountRate: null,
    discountSum: null,
    taxRate: null,
    taxIncluded: 'Y',
    measureCode: null,
    measureName: null,
  };
}

function deal(updatedTime = '2026-09-25T10:00:00+03:00') {
  return { id: '8204', updatedTime, currencyId: 'KZT', opportunity: '50' };
}

function harness(overrides: {
  reverseEnabled?: boolean;
  dryRun?: boolean;
  actorUserId?: number | null;
  fence?: { syncVersion: string; syncedAt: string | null } | null;
  items?: Array<Record<string, unknown>>;
  rowReads?: Array<Array<Record<string, unknown>>>;
} = {}) {
  const bitrix = {
    getCrmItem: vi.fn(async () => (overrides.items ?? [deal()]).shift() ?? deal()),
    listDealProductRows: vi.fn(
      async () => overrides.rowReads?.shift() ?? [row('1', '10')],
    ),
  };
  const repository = {
    getProductSyncFence: vi.fn(
      async () =>
        overrides.fence === undefined
          ? { syncVersion: '3', syncedAt: '2026-09-25T09:00:00Z' }
          : overrides.fence,
    ),
    applyDealProductSnapshot: vi.fn(async () => ({
      status: 'ready',
      requestId: 41,
      orderId: 10798,
      reason: null,
      blockedIds: [],
    })),
    findActiveRequestByOrderId: vi.fn(async () => null),
  };
  const config = {
    getBitrix24: vi.fn(async () => ({ currencyId: 'KZT' })),
    getReverseSync: vi.fn(async () => ({
      enabled: overrides.reverseEnabled ?? true,
      dryRun: overrides.dryRun ?? false,
      actorUserId: overrides.actorUserId === undefined ? 99 : overrides.actorUserId,
      portalTimezone: 'Asia/Almaty',
    })),
  };
  const service = new Bitrix24ProductSyncService(
    repository as never,
    bitrix as never,
    config as never,
  );
  return { service, bitrix, repository };
}

const SYNC_INPUT = { dealId: '8204', auditRequestId: 'test-req' };

describe('Bitrix24ProductSyncService.syncDeal', () => {
  it('applies a coherent complete read', async () => {
    const { service, repository } = harness();
    const result = await service.syncDeal(SYNC_INPUT);
    expect(result.status).toBe('ready');
    expect(repository.applyDealProductSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: '8204',
        expectedCurrencyId: 'KZT',
        currencyId: 'KZT',
        opportunity: '50.00',
        remoteUpdatedAt: '2026-09-25T10:00:00+03:00',
      }),
    );
  });

  it('skips before any remote read when no active request was observed', async () => {
    const { service, bitrix, repository } = harness({ fence: null });
    const result = await service.syncDeal(SYNC_INPUT);
    expect(result.status).toBe('skipped');
    expect(bitrix.getCrmItem).not.toHaveBeenCalled();
    expect(bitrix.listDealProductRows).not.toHaveBeenCalled();
    expect(repository.applyDealProductSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when reverse sync is disabled or dry-run', async () => {
    for (const flags of [{ reverseEnabled: false }, { dryRun: true }]) {
      const { service, bitrix } = harness(flags);
      await expect(service.syncDeal(SYNC_INPUT)).rejects.toMatchObject({
        statusCode: 503,
        code: 'BITRIX24_REVERSE_SYNC_DISABLED',
      });
      expect(bitrix.getCrmItem).not.toHaveBeenCalled();
    }
  });

  it('retries and fails when the Deal revision changes between reads', async () => {
    const { service, repository } = harness({
      items: [
        deal('2026-09-25T10:00:00+03:00'),
        deal('2026-09-25T10:00:01+03:00'),
        deal('2026-09-25T10:00:02+03:00'),
        deal('2026-09-25T10:00:03+03:00'),
      ],
    });
    await expect(service.syncDeal(SYNC_INPUT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'BITRIX24_PRODUCT_SYNC_INCOHERENT',
    });
    expect(repository.applyDealProductSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a same-total row swap detected only by the second row read', async () => {
    const { service, repository } = harness({
      rowReads: [
        [row('1', '10'), row('2', '20')],
        [row('3', '30', '100')],
        [row('1', '10'), row('2', '20')],
        [row('3', '30', '100')],
      ],
    });
    await expect(service.syncDeal(SYNC_INPUT)).rejects.toMatchObject({
      code: 'BITRIX24_PRODUCT_SYNC_INCOHERENT',
    });
    expect(repository.applyDealProductSnapshot).not.toHaveBeenCalled();
  });

  it('applies an empty complete remote list (legacy-empty requests)', async () => {
    const { service, repository } = harness({ rowReads: [[], []] });
    const result = await service.syncDeal(SYNC_INPUT);
    expect(result.status).toBe('ready');
    expect(repository.applyDealProductSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [] }),
    );
  });

  it('fails when the reverse service actor is not configured', async () => {
    const { service, repository } = harness({ actorUserId: null });
    await expect(service.syncDeal(SYNC_INPUT)).rejects.toMatchObject({
      statusCode: 503,
      code: 'BITRIX24_PRODUCT_SYNC_FAILED',
    });
    expect(repository.applyDealProductSnapshot).not.toHaveBeenCalled();
  });

  it('syncForOrderId skips without remote reads when no active request', async () => {
    const { service, bitrix } = harness();
    const result = await service.syncForOrderId(10798, 'req');
    expect(result.status).toBe('skipped');
    expect(bitrix.listDealProductRows).not.toHaveBeenCalled();
  });
});
