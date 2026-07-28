import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(resolve(__dirname, '../../contracts/04-api-contract.openapi.yaml'), 'utf8');

describe('Telegram notification channel OpenAPI contract', () => {
  it('documents profile link lifecycle and delivery worker routes', () => {
    expect(contract).toContain('  /api/v1/me/notification-channels/telegram:');
    expect(contract).toContain('  /api/v1/me/notification-channels/telegram/link:');
    expect(contract).toContain('  /api/v1/notification-channels/telegram/process-now:');
    expect(contract).toContain('x-permission: notifications.manage_rules');
  });

  it('documents Telegram webhook secret header without bearer auth', () => {
    const section = between(
      '  /api/v1/notification-channels/telegram/webhook:',
      '  /api/v1/notification-channels/telegram/process-now:',
    );
    expect(section).toContain('name: X-Telegram-Bot-Api-Secret-Token');
    expect(section).not.toContain('bearerAuth');
  });

  it('keeps raw Telegram identifiers out of profile response schema', () => {
    const section = between(
      '    TelegramNotificationChannelStatus:',
      '    TelegramNotificationChannelLink:',
    );
    expect(section).toContain('displayName:');
    expect(section).not.toContain('chatId');
    expect(section).not.toContain('externalUserId');
    expect(section).not.toContain('destination');
  });
});

function between(start: string, end: string): string {
  const startIndex = contract.indexOf(start);
  const endIndex = contract.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contract.slice(startIndex, endIndex);
}
