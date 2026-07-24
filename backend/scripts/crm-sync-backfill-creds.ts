import { isBitrix24WebhookUrl } from '../src/config/env.validation';

export interface Bitrix24BackfillConfig {
  webhookUrl: string;
  paySystemId: number;
  currencyId: string;
  assignedById: number | null;
  erpBaseUrl: string;
  requestTimeoutMs: number;
}

export function assertBitrix24BackfillTiming(
  requestTimeoutMs: number,
  leaseMs: number,
): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 60_000) {
    throw new Error('BACKEND_BITRIX24_SYNC_LEASE_MS must be an integer >= 60000');
  }
  if (requestTimeoutMs >= leaseMs) {
    throw new Error(
      'BITRIX24_REQUEST_TIMEOUT_MS must be less than BACKEND_BITRIX24_SYNC_LEASE_MS',
    );
  }
}

export function resolveBitrix24Config(
  env: NodeJS.ProcessEnv,
): Bitrix24BackfillConfig | null {
  const webhookUrl = (env.BITRIX24_WEBHOOK_URL ?? '').trim().replace(/\/+$/, '');
  const paySystemId = Number(env.BITRIX24_PAY_SYSTEM_ID);
  if (!webhookUrl || !isBitrix24WebhookUrl(webhookUrl)) return null;
  if (!Number.isInteger(paySystemId) || paySystemId <= 0) return null;

  const assigned = Number(env.BITRIX24_ASSIGNED_BY_ID);
  const requestTimeoutMs = Number(env.BITRIX24_REQUEST_TIMEOUT_MS ?? '30000');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) {
    return null;
  }
  return {
    webhookUrl,
    paySystemId,
    currencyId: (env.BITRIX24_CURRENCY_ID ?? 'KZT').trim().toUpperCase(),
    assignedById: Number.isInteger(assigned) && assigned > 0 ? assigned : null,
    erpBaseUrl: (env.FRONTEND_ORIGIN ?? 'http://localhost:5173').trim().replace(/\/+$/, ''),
    requestTimeoutMs,
  };
}
