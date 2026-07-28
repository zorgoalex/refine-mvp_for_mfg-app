import { describe, expect, it, vi } from 'vitest';
import type { PgTelegramNotificationsRepository } from './pg-telegram-notifications.repository';
import type { TelegramBotApiClient } from './telegram-bot-api.client';
import { TelegramNotificationDeliveryService } from './telegram-notification-delivery.service';
import type { TelegramNotificationsRuntimeConfigService } from './telegram-notifications-runtime-config.service';

describe('TelegramNotificationDeliveryService', () => {
  it('skips recipients without a Telegram binding', async () => {
    const repository = fakeRepository({ destination: null });
    const service = createService(repository, {
      sendMessage: vi.fn(),
    });

    await expect(service.processBatchOnce()).resolves.toMatchObject({
      claimed: 1,
      skipped: 1,
      delivered: 0,
    });
    expect(repository.markSkipped).toHaveBeenCalledWith(
      'delivery-1',
      'TELEGRAM_NOT_CONNECTED',
      expect.any(String),
    );
  });

  it('reschedules explicit 429 but marks uncertain network outcomes unknown', async () => {
    const rateLimitedRepository = fakeRepository({ destination: '123' });
    const rateLimited = createService(rateLimitedRepository, {
      sendMessage: vi.fn(async () => ({
        kind: 'rate_limited' as const,
        retryAfterSeconds: 5,
        code: 'TELEGRAM_RATE_LIMITED',
        message: 'limit',
      })),
    });
    await expect(rateLimited.processBatchOnce()).resolves.toMatchObject({ rescheduled: 1 });
    expect(rateLimitedRepository.rescheduleRateLimited).toHaveBeenCalledTimes(1);

    const unknownRepository = fakeRepository({ destination: '123' });
    const unknown = createService(unknownRepository, {
      sendMessage: vi.fn(async () => ({
        kind: 'unknown' as const,
        code: 'TELEGRAM_TRANSPORT_UNCERTAIN',
        message: 'unknown',
      })),
    });
    await expect(unknown.processBatchOnce()).resolves.toMatchObject({ unknown: 1 });
    expect(unknownRepository.markUnknown).toHaveBeenCalledWith(
      'delivery-1',
      'TELEGRAM_TRANSPORT_UNCERTAIN',
      'unknown',
    );
    expect(unknownRepository.rescheduleRateLimited).not.toHaveBeenCalled();
  });
});

function createService(
  repository: ReturnType<typeof fakeRepository>,
  botApi: Pick<TelegramBotApiClient, 'sendMessage'>,
) {
  const runtimeConfig = {
    getConfig: () => ({
      enabled: true,
      botToken: 'token',
      botUsername: 'test_bot',
      webhookSecret: 'x'.repeat(32),
      apiBase: 'http://localhost:8788',
      requestTimeoutMs: 1000,
      linkTtlSeconds: 600,
      relayOwner: 'none' as const,
      relayPollIntervalMs: 10000,
      relayBatchSize: 50,
      relayWorkerId: 'test-worker',
      relayMaxAttempts: 10,
      relayStaleLockMs: 600000,
    }),
  };
  return new TelegramNotificationDeliveryService(
    repository as unknown as PgTelegramNotificationsRepository,
    runtimeConfig as TelegramNotificationsRuntimeConfigService,
    botApi as TelegramBotApiClient,
  );
}

function fakeRepository(input: { destination: string | null }) {
  return {
    markStaleProcessingUnknown: vi.fn(async () => 0),
    claimPending: vi.fn(async () => [
      {
        deliveryId: 'delivery-1',
        userId: '7',
        title: 'Title',
        message: 'Message',
        attempts: 1,
      },
    ]),
    findDestination: vi.fn(async () => input.destination),
    markDelivered: vi.fn(async () => undefined),
    markSkipped: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    markUnknown: vi.fn(async () => undefined),
    rescheduleRateLimited: vi.fn(async () => undefined),
  };
}
