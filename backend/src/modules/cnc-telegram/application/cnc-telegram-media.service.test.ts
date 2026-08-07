import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { CncTelegramMediaService } from './cnc-telegram-media.service';

describe('CncTelegramMediaService', () => {
  it('requires orders.view for order screenshot metadata and restore requests', async () => {
    const repository = repositoryMock();
    const service = new CncTelegramMediaService(repository as never, config() as never);

    await expect(service.listOrderScreenshots(user([]), 2700)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED', statusCode: 403,
    });
    await expect(service.requestRestore({
      currentUser: user([]), orderId: 2700, packetId: packetId(),
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(repository.listOrderScreenshots).not.toHaveBeenCalled();
    expect(repository.requestRestore).not.toHaveBeenCalled();
  });

  it('binds order-scoped URLs and exposes the fixed 30-day contract', async () => {
    const repository = repositoryMock();
    repository.listOrderScreenshots.mockResolvedValue([{
      packetId: packetId(),
      sourceMessageId: 10847,
      sourceCreatedAt: '2026-08-01T08:00:00.000Z',
      programName: null,
      materialName: 'MDF',
      matchedDetailCount: 2,
      itemQuantityTotal: 3,
      previewUrl: `/api/v1/cnc-telegram/orders/2700/screenshots/${packetId()}/preview`,
      imageUrl: `/api/v1/cnc-telegram/orders/2700/screenshots/${packetId()}/image`,
      originalAvailable: true,
      availableUntil: '2026-08-31T08:00:00.000Z',
      restore: null,
    }]);
    const service = new CncTelegramMediaService(repository as never, config() as never);

    const result = await service.listOrderScreenshots(user(['orders.view']), 2700);

    expect(result.originalRetentionDays).toBe(30);
    expect(result.screenshots[0]?.previewUrl).toContain('/orders/2700/screenshots/');
    expect(result.screenshots[0]?.previewUrl).not.toContain('__ORDER_ID__');
  });

  it('restricts queue claim and completion to configured worker identity', async () => {
    const repository = repositoryMock();
    const service = new CncTelegramMediaService(repository as never, config() as never);

    await expect(service.claimRestores(user(['cut.manage']))).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.claimRestores(user(['cut.manage'], 'cnc-worker'))).resolves.toMatchObject({
      capability: 'cnc_telegram_media_restore_v1',
    });
    expect(repository.claimRestores).toHaveBeenCalledWith(['-1001996415689'], 5);
  });

  it('returns 410 before reading an expired original', async () => {
    const repository = repositoryMock();
    repository.resolveOrderScreenshot.mockResolvedValue({
      packetId: packetId(), sourceMessageId: 10, sourceCreatedAt: '2026-06-01T00:00:00.000Z',
      storageKey: 'tg_chat_10.jpg', contentType: 'image/jpeg', sizeBytes: 10,
      originalAvailable: false, availableUntil: '2026-07-01T00:00:00.000Z',
    });
    const service = new CncTelegramMediaService(repository as never, config() as never);

    await expect(service.openOriginal(user(['orders.view']), 2700, packetId())).rejects.toMatchObject({
      code: 'CNC_TELEGRAM_MEDIA_EXPIRED', statusCode: 410,
    });
  });
});

function repositoryMock() {
  return {
    listOrderScreenshots: vi.fn().mockResolvedValue([]),
    resolveOrderScreenshot: vi.fn(),
    requestRestore: vi.fn(),
    claimRestores: vi.fn().mockResolvedValue([]),
    completeRestore: vi.fn(),
    failRestore: vi.fn(),
  };
}

function config() {
  return {
    get: vi.fn((key: string) => ({
      CNC_TELEGRAM_WORKER_USERNAME: 'cnc-worker',
      CNC_TELEGRAM_ALLOWED_CHAT_IDS: '-1001996415689',
      CNC_TELEGRAM_MEDIA_DIR: '/data/cnc-telegram-media',
    })[key]),
  };
}

function user(permissions: CurrentUser['permissions'], username = 'operator'): CurrentUser {
  return { id: '42', username, role: 'operator', roleId: 11, permissions };
}

function packetId(): string {
  return '00000000-0000-4000-8000-000000000001';
}
