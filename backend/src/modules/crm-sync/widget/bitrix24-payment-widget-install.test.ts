import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { Request, Response as ExpressResponse } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContextService } from '../../../common/request-context/request-context.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import { hashBitrix24ApplicationToken } from '../reverse/bitrix24-token-cipher';
import { Bitrix24PaymentWidgetInstallController } from './bitrix24-payment-widget-install.controller';
import { Bitrix24PaymentWidgetInstallService } from './bitrix24-payment-widget-install.service';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

const domain = 'bitrix.example';
const memberId = 'test-member-12345678';
const form = {
  AUTH_ID: 'test-access-token', REFRESH_ID: 'test-refresh-token',
  AUTH_EXPIRES: '3600', member_id: memberId, status: 'L',
  APPLICATION_TOKEN: 'test-application-token',
};
const appHash = hashBitrix24ApplicationToken(form.APPLICATION_TOKEN);

function setup(options: { installed?: boolean; admin?: boolean; appCode?: string } = {}) {
  const env = new ConfigService<BackendEnv, true>({
    DATABASE_URL: '', API_PREFIX: '/api/v1',
    BACKEND_ENABLE_BITRIX24_PAYMENT_WIDGET: true,
    BACKEND_ENABLE_BITRIX24_REVERSE_SYNC: true,
    BITRIX24_APP_PORTAL_DOMAIN: domain,
    BITRIX24_APP_CLIENT_ID: 'local.test-app',
    BITRIX24_APP_PUBLIC_BASE_URL: 'https://backend.example',
    BITRIX24_APP_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  const config = new CrmSyncRuntimeConfigService(env);
  const db = new DatabaseService(env, new PerformanceQueryTelemetryService(env, new RequestContextService()));
  const repository = new Bitrix24PaymentWidgetRepository(db, new AuditService());
  const save = vi.spyOn(repository, 'saveInstallAttempt').mockResolvedValue({
    attemptId: '1', memberId, domain, applicationTokenHash: appHash,
    executorBitrixUserId: '17', expiresAt: new Date(Date.now() + 60_000),
  });
  const active = vi.spyOn(repository, 'getActiveInstallation').mockResolvedValue({
    memberId, domain, applicationTokenHash: appHash, executorBitrixUserId: '17',
    accessTokenCiphertext: 'encrypted', refreshTokenCiphertext: 'encrypted',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  });
  const query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [], rowCount: 0 });
  const promote = vi.spyOn(repository, 'promoteInstallAttempt').mockResolvedValue();
  const fetchFn = vi.fn(async (url: string) => {
    const method = url.split('/').pop();
    let result: unknown;
    switch (method) {
      case 'app.info': result = { CODE: options.appCode ?? 'local.test-app', STATUS: 'L', INSTALLED: options.installed ?? true }; break;
      case 'user.current': result = { ID: '17', NAME: 'Тест', ACTIVE: true }; break;
      case 'user.admin': result = options.admin ?? true; break;
      case 'event.get': case 'placement.get': result = []; break;
      case 'event.bind': case 'placement.bind': result = true; break;
      default: throw new Error(`Unexpected test method: ${method}`);
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
  const service = new Bitrix24PaymentWidgetInstallService(repository, config, new Bitrix24LocalAppClient(fetchFn));
  const controller = new Bitrix24PaymentWidgetInstallController(service, config);
  const response = { set: vi.fn(), removeHeader: vi.fn(), status: vi.fn(), send: vi.fn() };
  response.status.mockReturnValue(response);
  response.set.mockReturnValue(response);
  const request = (q: Request['query']) => ({ query: q, requestId: 'req-test-install' }) as Request;
  const open = (body: unknown = form, q: Request['query'] = { DOMAIN: domain, PROTOCOL: '1', LANG: 'ru' }) =>
    controller.appPost(request(q), undefined, body, response as unknown as ExpressResponse);
  const begin = (body: unknown = form, q: Request['query'] = { DOMAIN: domain }) =>
    controller.installUi(request(q), body, response as unknown as ExpressResponse);
  return { begin, open, response, save, active, promote, query, fetchFn, repository, service, controller };
}

describe('Bitrix app/install callback transport', () => {
  it('serves the install script referenced by the HTML as uncached JavaScript', () => {
    const h = setup();
    h.controller.installJs(h.response as unknown as ExpressResponse);
    expect(h.response.set).toHaveBeenCalledWith(expect.objectContaining({
      'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store',
    }));
    expect(h.response.send).toHaveBeenCalledWith(expect.stringContaining('BX24.installFinish();'));
  });
  it('opens an active app with DOMAIN in query and OAuth fields in form body', async () => {
    const h = setup();
    await h.open();
    expect(h.response.status).toHaveBeenLastCalledWith(200);
    expect(h.active).toHaveBeenCalledWith(memberId, domain);
    expect(h.response.send).toHaveBeenCalledWith(expect.stringContaining('Приложение активно'));
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('registers the widget from an iframe installation query/form POST', async () => {
    const h = setup({ installed: false });
    await h.begin();
    expect(h.response.status).toHaveBeenLastCalledWith(200);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ memberId, domain, executorBitrixUserId: '17' }));
    expect(h.fetchFn.mock.calls.some(([url]) => url.endsWith('/placement.bind'))).toBe(true);
    expect(h.response.send).toHaveBeenCalledWith(expect.stringContaining('data-install-state='));
  });

  it('preserves the legacy nested-auth installation payload', async () => {
    const h = setup({ installed: false });
    await h.begin({ auth: { access_token: form.AUTH_ID, refresh_token: form.REFRESH_ID,
      expires_in: 3600, member_id: memberId, status: 'L', domain,
      application_token: form.APPLICATION_TOKEN } }, {});
    expect(h.response.status).toHaveBeenLastCalledWith(200);
    expect(h.save).toHaveBeenCalledOnce();
  });

  it.each(['open', 'begin'] as const)('%s rejects conflicting query/body domains before REST or storage', async (method) => {
    const h = setup({ installed: method === 'open' });
    await h[method]({ ...form, DOMAIN: 'foreign.example' });
    expect(h.response.status).toHaveBeenLastCalledWith(400);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it.each(['open', 'begin'] as const)('%s rejects an unapproved portal before any REST request', async (method) => {
    const h = setup({ installed: method === 'open' });
    await h[method](form, { DOMAIN: 'foreign.example' });
    expect(h.response.status).toHaveBeenLastCalledWith(403);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each(['open', 'begin'] as const)('%s rejects a repeated DOMAIN query parameter', async (method) => {
    const h = setup({ installed: method === 'open' });
    await h[method](form, { DOMAIN: [domain, domain] });
    expect(h.response.status).toHaveBeenLastCalledWith(400);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each([{ admin: false }, { appCode: 'local.foreign-app' }])('does not activate an unauthorized context %j', async (options) => {
    const h = setup(options);
    await h.open();
    expect(h.response.status).toHaveBeenLastCalledWith(403);
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.active).not.toHaveBeenCalled();
  });

  it('does not activate an installation merely because app.info succeeds', async () => {
    const h = setup();
    h.active.mockResolvedValue(null);
    await h.open();
    expect(h.response.status).toHaveBeenLastCalledWith(409);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('finalizes the persisted attempt after Bitrix reloads /app without state', async () => {
    const h = setup();
    h.active.mockResolvedValue(null);
    h.query.mockResolvedValue({ rows: [{
      attempt_id: '12', member_id: memberId, domain,
      application_token_hash: appHash, executor_bitrix_user_id: '17',
      expires_at: new Date(Date.now() + 60_000), state_token_hash: 'test-state-hash',
    }], rowCount: 1 });
    await h.open();
    expect(h.response.status).toHaveBeenLastCalledWith(200);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining("status='installing' AND expires_at>now()"),
      [memberId, domain, '17', appHash]);
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY created_at DESC, attempt_id DESC');
    // Filter AFTER choosing the latest attempt: a promoted/expired newest
    // attempt must not expose an older pending retry on the next app open.
    const sql = h.query.mock.calls[0][0];
    expect(sql.indexOf('LIMIT 1')).toBeLessThan(sql.indexOf("status='installing'"));
    expect(h.promote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      stateTokenHash: 'test-state-hash', memberId, domain, executorBitrixUserId: '17',
      applicationTokenHash: appHash, requestId: 'req-test-install',
    }));
    expect(h.promote.mock.calls[0][0].accessTokenCiphertext).not.toContain(form.AUTH_ID);
    expect(h.promote.mock.calls[0][0].refreshTokenCiphertext).not.toContain(form.REFRESH_ID);
    expect(h.active).not.toHaveBeenCalled();
  });

  it('does not recover a pending installation without application-token proof', async () => {
    const h = setup();
    h.active.mockResolvedValue(null);
    const { APPLICATION_TOKEN: _, ...withoutApplicationToken } = form;
    await h.open(withoutApplicationToken);
    expect(h.response.status).toHaveBeenLastCalledWith(409);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it.each([{ member_id: 'foreign-member-123' }, { executor_bitrix_user_id: '99' },
    { domain: 'foreign.example' }, { application_token_hash: 'wrong-hash' }])(
    'rechecks recovered identity before promotion: %j', async (mismatch) => {
      const h = setup();
      h.query.mockResolvedValue({ rows: [{
        attempt_id: '12', member_id: memberId, domain,
        application_token_hash: appHash, executor_bitrix_user_id: '17',
        expires_at: new Date(Date.now() + 60_000), state_token_hash: 'test-state-hash',
        ...mismatch,
      }], rowCount: 1 });
      await h.open();
      expect(h.response.status).toHaveBeenLastCalledWith(409);
      expect(h.promote).not.toHaveBeenCalled();
    });

  it('rejects a foreign application token when reopening an active installation', async () => {
    const h = setup();
    await h.open({ ...form, APPLICATION_TOKEN: 'foreign-application-token' });
    expect(h.response.status).toHaveBeenLastCalledWith(409);
    expect(h.promote).not.toHaveBeenCalled();
  });

  it.each([
    { AUTH_ID: ['token-one', 'token-two'] },
    { auth: { domain: 'foreign.example' }, DOMAIN: domain },
    { auth: [] },
    { access_token: 'different-access-token' },
  ])('rejects malformed or conflicting auth fields without external effects: %j', async (invalid) => {
    const h = setup();
    await h.open({ ...form, ...invalid });
    expect(h.response.status).toHaveBeenLastCalledWith(400);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('retains explicit-state finalization for compatible existing callers', async () => {
    const h = setup();
    vi.spyOn(h.repository, 'getInstallAttempt').mockResolvedValue({
      attemptId: '12', memberId, domain, executorBitrixUserId: '17',
      applicationTokenHash: appHash, expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(h.service.finish({ state: 's'.repeat(43), body: { ...form, DOMAIN: domain },
      requestId: 'req-test-explicit-state' })).resolves.toMatchObject({ status: 'active' });
    expect(h.promote).toHaveBeenCalledOnce();
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('Bitrix install SDK handoff', () => {
  const source = readFileSync(new URL('../../../../assets/bitrix24-payment-widget/install.js', import.meta.url), 'utf8');

  it('uses parameterless installFinish, with no SDK auth snapshot or delayed POST', () => {
    const notice = { textContent: '', className: '' };
    const BX24 = { init: (fn: () => void) => fn(), installFinish: vi.fn(), getAuth: vi.fn() };
    const fetch = vi.fn();
    const setTimeout = vi.fn();
    runInNewContext(source, { window: { BX24 }, BX24, fetch, setTimeout,
      document: { getElementById: () => notice } });
    expect(BX24.installFinish).toHaveBeenCalledExactlyOnceWith();
    expect(BX24.getAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it('shows a visible failure when the SDK cannot load', () => {
    const notice = { textContent: '', className: '' };
    runInNewContext(source, { window: {}, document: { getElementById: () => notice } });
    expect(notice.textContent).toContain('Не загрузился официальный SDK');
  });
});
