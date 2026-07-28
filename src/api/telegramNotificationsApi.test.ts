import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from './httpClient';
import { telegramNotificationsApi } from './telegramNotificationsApi';

describe('telegramNotificationsApi', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses current-user channel routes without exposing Telegram identifiers', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue({
      available: true,
      connected: false,
    });
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue({
      linkUrl: 'https://t.me/test_bot?start=token',
      expiresAt: '2026-07-27T20:00:00.000Z',
    });
    const remove = vi.spyOn(httpClient, 'delete').mockResolvedValue({ disconnected: true });

    await telegramNotificationsApi.getStatus();
    await telegramNotificationsApi.startLink();
    await telegramNotificationsApi.unlink();

    expect(get).toHaveBeenCalledWith('/api/v1/me/notification-channels/telegram');
    expect(post).toHaveBeenCalledWith(
      '/api/v1/me/notification-channels/telegram/link',
      undefined,
    );
    expect(remove).toHaveBeenCalledWith('/api/v1/me/notification-channels/telegram');
  });
});
