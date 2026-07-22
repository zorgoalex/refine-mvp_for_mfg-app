/**
 * Read-only Bitrix24 stage canary.
 *
 * It validates deployed ERP schema/runtime plus CRM and payment-system access,
 * but deliberately creates no Bitrix records (CRM deletes use the recycle bin).
 * Fail-closed unless the operator supplies the explicit flag and webhook.
 */
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const enabled = process.env.BITRIX24_SYNC_STAGE_CANARY === 'true';
const webhookUrl = normalizeWebhook(process.env.BITRIX24_WEBHOOK_URL ?? '');
const paySystemId = Number(process.env.BITRIX24_PAY_SYSTEM_ID);
const postgresContainer =
  process.env.BITRIX24_SYNC_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const backendContainer =
  process.env.BITRIX24_SYNC_STAGE_BACKEND_CONTAINER ?? 'erp_test-backend-1';
const requiredMethods = [
  'crm.item.add',
  'crm.item.get',
  'crm.item.update',
  'crm.item.list',
  'crm.item.delete',
  'crm.item.productrow.set',
  'crm.item.payment.add',
  'crm.item.payment.list',
  'crm.item.payment.delete',
  'sale.payment.list',
  'sale.payment.update',
  'sale.paysystem.list',
] as const;

function normalizeWebhook(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mebelkz.bitrix24.kz' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/rest\/\d+\/[^/]+\/?$/.test(url.pathname)
    ) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function safeContainer(name: string, kind: 'postgres' | 'backend'): boolean {
  if (/prod|production|live/i.test(name)) return false;
  const expected = kind === 'postgres'
    ? /^erp_test-postgresdb(-\d+)?$/
    : /^erp_test-backend(-\d+)?$/;
  return expected.test(name);
}

function containerExists(name: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function containerEnv(name: string, key: string): string {
  return execFileSync('docker', ['exec', name, 'printenv', key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function schemaProbe(): string {
  return execFileSync(
    'docker',
    [
      'exec',
      postgresContainer,
      'sh',
      '-lc',
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAtX -v ON_ERROR_STOP=1 -c ` +
      `"SELECT concat_ws('|', ` +
      `(SELECT count(*) FROM schema_migrations WHERE filename='074_bitrix24_payment_delivery_guards.sql'), ` +
      `to_regclass('crm_sync_payment_create_guard'), ` +
      `to_regclass('crm_sync_writer_lock'), ` +
      `(SELECT count(*) FROM pg_trigger WHERE tgname='trg_crm_sync_payments' AND NOT tgisinternal));"`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

async function bitrixCall(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${webhookUrl}/${method}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as {
    result?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  if (!response.ok || body.error !== undefined) {
    throw new Error(
      `Bitrix24 read-only canary ${method} failed: ` +
      `${response.status} ${String(body.error ?? 'HTTP_ERROR')} ` +
      `${String(body.error_description ?? '')}`,
    );
  }
  return body.result;
}

test.describe('Bitrix24 sync read-only stage canary', () => {
  test.skip(!enabled, 'Run with BITRIX24_SYNC_STAGE_CANARY=true');
  test.skip(enabled && !webhookUrl, 'A valid mebelkz.bitrix24.kz webhook is required');
  test.skip(
    enabled && (!Number.isInteger(paySystemId) || paySystemId <= 0),
    'BITRIX24_PAY_SYSTEM_ID is required',
  );
  test.skip(
    enabled && !safeContainer(postgresContainer, 'postgres'),
    'Only the anchored erp_test Postgres container is allowed',
  );
  test.skip(
    enabled && !safeContainer(backendContainer, 'backend'),
    'Only the anchored erp_test backend container is allowed',
  );
  test.skip(
    enabled && (
      !containerExists(postgresContainer) ||
      !containerExists(backendContainer)
    ),
    'The erp_test containers must be running',
  );

  test('verifies deployed writer, CRM read scope, and configured payment system', async () => {
    expect(containerEnv(backendContainer, 'BACKEND_ENABLE_BITRIX24_SYNC')).toBe('true');
    expect(containerEnv(backendContainer, 'BACKEND_BITRIX24_SYNC_RELAY_OWNER'))
      .toMatch(/^(in_process|external)$/);
    expect(schemaProbe()).toBe(
      '1|crm_sync_payment_create_guard|crm_sync_writer_lock|1',
    );

    for (const method of requiredMethods) {
      const availability = await bitrixCall('method.get', {
        name: method,
      }) as {
        isExisting?: boolean;
        isAvailable?: boolean;
      };
      expect(
        availability,
        `Webhook user cannot call required Bitrix24 method ${method}`,
      ).toMatchObject({
        isExisting: true,
        isAvailable: true,
      });
    }

    const crmResult = await bitrixCall('crm.item.list', {
      entityTypeId: 2,
      select: ['id'],
      filter: {
        originatorId: 'MEBELKZ_ERP_CANARY_READ_ONLY_NEVER_MATCH',
      },
      start: 0,
    }) as { items?: unknown[] };
    expect(Array.isArray(crmResult?.items)).toBe(true);

    const paySystemResult = await bitrixCall('sale.paysystem.list', {
      select: ['id', 'name', 'active'],
      filter: { '@id': [paySystemId] },
      start: 0,
    }) as { paySystems?: Array<{ id?: number | string }> } | Array<{
      id?: number | string;
    }>;
    const paySystems = Array.isArray(paySystemResult)
      ? paySystemResult
      : paySystemResult?.paySystems ?? [];
    expect(paySystems.some((item) => Number(item.id) === paySystemId)).toBe(true);
  });
});
