import { describe, expect, it, vi } from 'vitest';
import {
  formatTelegramNotification,
  TelegramBotApiClient,
} from './telegram-bot-api.client';

describe('TelegramBotApiClient', () => {
  it('sends plain text and returns Telegram message id', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelegramBotApiClient({
      apiBase: 'http://localhost:8788',
      botToken: 'secret-token',
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.sendMessage('123', 'Заголовок\n\nТекст')).resolves.toEqual({
      kind: 'delivered',
      messageId: '42',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, request] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toEqual({
      chat_id: '123',
      text: 'Заголовок\n\nТекст',
      link_preview_options: { is_disabled: true },
    });
  });

  it('retries only an explicit 429 with retry_after', async () => {
    const client = clientWithResponse(429, {
      ok: false,
      description: 'Too Many Requests',
      parameters: { retry_after: 7 },
    });
    await expect(client.sendMessage('123', 'text')).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 7,
      code: 'TELEGRAM_RATE_LIMITED',
      message: 'Too Many Requests',
    });
  });

  it('classifies recipient rejection as permanent and network failures as unknown', async () => {
    await expect(
      clientWithResponse(403, { ok: false, description: 'bot was blocked' }).sendMessage(
        '123',
        'text',
      ),
    ).resolves.toMatchObject({ kind: 'permanent_failure', code: 'TELEGRAM_HTTP_403' });

    const client = new TelegramBotApiClient({
      apiBase: 'http://localhost:8788',
      botToken: 'secret-token',
      timeoutMs: 1000,
      fetchImpl: vi.fn(async () => {
        throw new Error('socket closed');
      }) as typeof fetch,
    });
    await expect(client.sendMessage('123', 'text')).resolves.toMatchObject({
      kind: 'unknown',
      code: 'TELEGRAM_TRANSPORT_UNCERTAIN',
    });
  });

  it('formats title and message without HTML parsing', () => {
    expect(formatTelegramNotification('<b>Title</b>', 'Message')).toBe(
      '<b>Title</b>\n\nMessage',
    );
  });
});

function clientWithResponse(status: number, payload: unknown): TelegramBotApiClient {
  return new TelegramBotApiClient({
    apiBase: 'http://localhost:8788',
    botToken: 'secret-token',
    timeoutMs: 1000,
    fetchImpl: vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch,
  });
}
