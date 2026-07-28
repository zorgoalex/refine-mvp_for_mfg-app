import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PgTelegramNotificationsRepository } from './pg-telegram-notifications.repository';
import type { TelegramBotApiClient } from './telegram-bot-api.client';
import type { TelegramNotificationsRuntimeConfigService } from './telegram-notifications-runtime-config.service';
import { TelegramNotificationsService } from './telegram-notifications.service';

describe('TelegramNotificationsService', () => {
  it('creates a short-lived deep link while storing only the token hash', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as TransactionClient;
    const database = {
      transaction: async <T>(handler: (client: TransactionClient) => Promise<T>) => handler(tx),
    } as DatabaseService;
    const service = createService(database);

    const result = await service.startLink(currentUser, 'req-1');
    expect(result.linkUrl).toMatch(/^https:\/\/t\.me\/erp_notice_bot\?start=[A-Za-z0-9_-]{32}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());

    const tokenInsert = queries.find((query) =>
      query.sql.includes('INSERT INTO notification_channel_link_tokens'),
    );
    expect(tokenInsert?.params[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(result.linkUrl).not.toContain(String(tokenInsert?.params[1]));
    expect(
      JSON.stringify(queries.filter((query) => query.sql.includes('audit_log'))),
    ).not.toContain('start=');
  });

  it('rejects webhook calls without the configured secret before database work', async () => {
    const database = {
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const service = createService(database);

    await expect(service.handleWebhook('wrong-secret', { update_id: 1 })).rejects.toMatchObject({
      statusCode: 401,
      code: 'TELEGRAM_WEBHOOK_UNAUTHORIZED',
    });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

const currentUser: CurrentUser = {
  id: '7',
  username: 'manager',
  role: 'manager',
  roleId: 2,
  permissions: [],
};

function createService(database: DatabaseService): TelegramNotificationsService {
  const repository = {
    findBindingByUserId: vi.fn(async () => null),
    markWebhookUpdateProcessed: vi.fn(async () => true),
  } as unknown as PgTelegramNotificationsRepository;
  const runtimeConfig = {
    getConfig: () => ({
      enabled: true,
      botToken: '123:token',
      botUsername: 'erp_notice_bot',
      webhookSecret: 'x'.repeat(32),
      apiBase: 'http://localhost:8788',
      requestTimeoutMs: 1000,
      linkTtlSeconds: 600,
      relayOwner: 'none' as const,
      relayPollIntervalMs: 10000,
      relayBatchSize: 50,
      relayWorkerId: 'worker',
      relayMaxAttempts: 10,
      relayStaleLockMs: 600000,
    }),
  } as TelegramNotificationsRuntimeConfigService;
  const botApi = { sendMessage: vi.fn() } as unknown as TelegramBotApiClient;
  return new TelegramNotificationsService(database, repository, runtimeConfig, botApi);
}
