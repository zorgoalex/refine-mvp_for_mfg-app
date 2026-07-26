import { isBitrix24WebhookUrl } from '../src/config/env.validation';

export interface Bitrix24BackfillConfig {
  webhookUrl: string;
  paySystemId: number;
  currencyId: string;
  assignedById: number | null;
  erpBaseUrl: string;
  requestTimeoutMs: number;
  maxRequestsPerSecond: number;
  limitRetryMaxAttempts: number;
  queryLimitBaseDelayMs: number;
  operationLimitFallbackDelayMs: number;
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
  const maxRequestsPerSecond = boundedInteger(
    env.BITRIX24_MAX_REQUESTS_PER_SECOND,
    2,
    1,
    5,
  );
  const limitRetryMaxAttempts = boundedInteger(
    env.BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS,
    11,
    1,
    20,
  );
  const queryLimitBaseDelayMs = boundedInteger(
    env.BITRIX24_QUERY_LIMIT_BASE_DELAY_MS,
    1000,
    100,
    60000,
  );
  const operationLimitFallbackDelayMs = boundedInteger(
    env.BITRIX24_OPERATION_LIMIT_FALLBACK_MS,
    60000,
    1000,
    600000,
  );
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) {
    return null;
  }
  if (
    maxRequestsPerSecond === null ||
    limitRetryMaxAttempts === null ||
    queryLimitBaseDelayMs === null ||
    operationLimitFallbackDelayMs === null
  ) {
    return null;
  }
  return {
    webhookUrl,
    paySystemId,
    currencyId: (env.BITRIX24_CURRENCY_ID ?? 'KZT').trim().toUpperCase(),
    assignedById: Number.isInteger(assigned) && assigned > 0 ? assigned : null,
    erpBaseUrl: (env.FRONTEND_ORIGIN ?? 'http://localhost:5173').trim().replace(/\/+$/, ''),
    requestTimeoutMs,
    maxRequestsPerSecond,
    limitRetryMaxAttempts,
    queryLimitBaseDelayMs,
    operationLimitFallbackDelayMs,
  };
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = Number(raw ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}
