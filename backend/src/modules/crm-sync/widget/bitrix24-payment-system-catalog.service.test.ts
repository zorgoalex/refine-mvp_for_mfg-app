import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContextService } from '../../../common/request-context/request-context.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import { Bitrix24OAuthTokenService } from '../reverse/bitrix24-oauth-token.service';
import { PgBitrix24ReverseRepository } from '../reverse/pg-bitrix24-reverse-repository';
import { Bitrix24PaymentSystemCatalogService } from './bitrix24-payment-system-catalog.service';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

function response(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

function setup(active: boolean, adminResult: unknown) {
  const env = new ConfigService<BackendEnv, true>({
    DATABASE_URL: '',
    BACKEND_ENABLE_BITRIX24_PAYMENT_WIDGET: true,
    BITRIX24_APP_PORTAL_DOMAIN: 'bitrix.example',
  });
  const config = new CrmSyncRuntimeConfigService(env);
  const db = new DatabaseService(env, new PerformanceQueryTelemetryService(env, new RequestContextService()));
  const audit = new AuditService();
  const repository = new Bitrix24PaymentWidgetRepository(db, audit);
  const replace = vi.spyOn(repository, 'replacePaySystemCatalog').mockResolvedValue(1);
  const tokens = new Bitrix24OAuthTokenService(new PgBitrix24ReverseRepository(db, audit), config);
  const getToken = vi.spyOn(tokens, 'getAccessToken').mockResolvedValue('test-installation-token');
  // Real REST client and catalog service; only transport/token storage/catalog
  // persistence are stubbed. The real authorization check must not be mocked.
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(response({ ID: '17', NAME: 'Тест', ACTIVE: active }))
    .mockResolvedValueOnce(response(adminResult))
    .mockResolvedValueOnce(response([
      { ID: 14, NAME: 'Тест наличные', ACTIVE: 'Y', IS_CASH: 'Y', ENTITY_REGISTRY_TYPE: 'ORDER' },
    ]));
  const service = new Bitrix24PaymentSystemCatalogService(
    repository, new Bitrix24LocalAppClient(fetchFn), tokens, config,
  );
  return { service, replace, getToken, fetchFn };
}

describe('Bitrix24 payment catalog authorization', () => {
  it('refreshes for an active admin without ADMIN in user.current and preserves audit context', async () => {
    const { service, replace, getToken, fetchFn } = setup(true, true);
    const audit = { actorUserId: 7, requestId: 'req-test-catalog-refresh' };
    await expect(service.refresh(audit)).resolves.toBe(1);
    expect(getToken).toHaveBeenCalledWith('bitrix.example');
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://bitrix.example/rest/user.current',
      'https://bitrix.example/rest/user.admin',
      'https://bitrix.example/rest/sale.paysystem.list',
    ]);
    expect(fetchFn.mock.calls.every(([, init]) =>
      JSON.parse(String(init.body)).auth === 'test-installation-token',
    )).toBe(true);
    expect(replace).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ paySystemId: 14, name: 'Тест наличные', active: true, isCash: true }),
    ], audit);
  });

  it.each([
    { active: true, admin: false },
    { active: false, admin: true },
  ])('blocks catalog reads/writes for active=$active admin=$admin', async ({ active, admin }) => {
    const { service, replace, fetchFn } = setup(active, admin);
    await expect(service.refresh()).rejects.toMatchObject({ code: 'BITRIX24_EXECUTOR_INVALID' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not fetch or persist the catalog when the admin check is malformed', async () => {
    const { service, replace, fetchFn } = setup(true, { ADMIN: true });
    await expect(service.refresh()).rejects.toMatchObject({ code: 'BITRIX24_INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
  });

  it('propagates admin API failure without fetching or persisting the catalog', async () => {
    const { service, replace, fetchFn } = setup(true, true);
    fetchFn.mockReset()
      .mockResolvedValueOnce(response({ ID: '17', ACTIVE: true }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(service.refresh()).rejects.toMatchObject({ code: 'BITRIX24_APP_REQUEST_FAILED' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
  });
});
