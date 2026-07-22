import { describe, expect, it } from 'vitest';
import {
  assertBitrix24BackfillTiming,
  resolveBitrix24Config,
} from './crm-sync-backfill-creds';

describe('CRM backfill Bitrix24 configuration', () => {
  it('normalizes configured values', () => {
    expect(resolveBitrix24Config({
      BITRIX24_WEBHOOK_URL: '  https://mebelkz.bitrix24.kz/rest/1/token/  ',
      BITRIX24_PAY_SYSTEM_ID: '7',
      BITRIX24_CURRENCY_ID: 'kzt',
      BITRIX24_ASSIGNED_BY_ID: '12',
      FRONTEND_ORIGIN: 'https://erp.example/',
    } as NodeJS.ProcessEnv)).toEqual({
      webhookUrl: 'https://mebelkz.bitrix24.kz/rest/1/token',
      paySystemId: 7,
      currencyId: 'KZT',
      assignedById: 12,
      erpBaseUrl: 'https://erp.example',
      requestTimeoutMs: 30000,
    });
  });

  it('rejects non-HTTPS webhooks', () => {
    expect(resolveBitrix24Config({
      BITRIX24_WEBHOOK_URL: 'http://mebelkz.bitrix24.kz/rest/1/token',
      BITRIX24_PAY_SYSTEM_ID: '1',
    } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('rejects missing payment-system ID', () => {
    expect(resolveBitrix24Config({
      BITRIX24_WEBHOOK_URL: 'https://mebelkz.bitrix24.kz/rest/1/token',
    } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('rejects a webhook for another host', () => {
    expect(resolveBitrix24Config({
      BITRIX24_WEBHOOK_URL: 'https://evil.example/rest/1/token',
      BITRIX24_PAY_SYSTEM_ID: '1',
    } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('refuses a request timeout that can outlive the backfill writer lease', () => {
    expect(() => assertBitrix24BackfillTiming(120_000, 60_000)).toThrow(
      'BITRIX24_REQUEST_TIMEOUT_MS must be less than BACKEND_BITRIX24_SYNC_LEASE_MS',
    );
    expect(() => assertBitrix24BackfillTiming(30_000, 300_000)).not.toThrow();
  });
});
