import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24OrderConversionController } from './bitrix24-order-conversion.controller';

const request: RequestWithCurrentUser = {
  user: { id: '3', username: 'E2E-conversion', role: 'admin', roleId: 1, permissions: ['bitrix24.requests.convert'] },
  requestId: 'E2E-conversion-request',
};
const body = { version: 1, orderName: 'E2E-converted', createProject: true, idempotencyKey: 'E2E-conversion-key' };

function setup(overrides: Partial<BackendEnv> = {}, linkState: string | null = 'converted') {
  const config = new CrmSyncRuntimeConfigService(new ConfigService<BackendEnv, true>({
    BACKEND_ENABLE_DEADLINES: true,
    BACKEND_DEADLINES_READ_ONLY: false,
    BACKEND_ENABLE_DEADLINE_ORDER_SYNC: false,
    BACKEND_ENABLE_NOTIFICATION_ENGINE: false,
    BACKEND_OUTBOX_RELAY_OWNER: 'none',
    BACKEND_ENABLE_DEADLINE_WORKER: false,
    BACKEND_ORDER_INITIAL_STATUS_CODE: 'legacy_1',
    BACKEND_ORDER_INITIAL_PRODUCTION_STATUS_CODE: 'drawn',
    ...overrides,
  }));
  const repository = {
    convertCrmRequestToProduction: vi.fn().mockResolvedValue({ orderId: 11634 }),
    findRequestLinkByOrderId: vi.fn().mockResolvedValue(
      linkState === null ? null : { state: linkState },
    ),
  };
  const productSync = { syncForOrderId: vi.fn().mockResolvedValue({ status: 'ready' }) };
  return {
    repository,
    productSync,
    controller: new Bitrix24OrderConversionController(
      repository as never, config, productSync as never,
    ),
  };
}

describe('CRM conversion production readiness', () => {
  it('accepts production flags with generic order sync, worker and notification relay OFF', async () => {
    const { controller, repository } = setup();
    await expect(controller.convert(request, '11634', body)).resolves.toEqual({ orderId: 11634 });
    expect(repository.convertCrmRequestToProduction).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 3, actorRole: 'admin', requestId: request.requestId,
      scope: { mode: 'all' }, expectedVersion: 1,
    }));
  });
  it.each([
    { BACKEND_ENABLE_DEADLINES: false },
    { BACKEND_DEADLINES_READ_ONLY: true },
  ])('keeps disabled/read-only deadline writes blocked: %j', async (flags) => {
    const { controller, repository } = setup(flags);
    await expect(controller.convert(request, '11634', body)).rejects.toThrow('Production deadline initialization is unavailable');
    expect(repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('preserves initial status validation', async () => {
    const { controller } = setup({ BACKEND_ORDER_INITIAL_STATUS_CODE: '' });
    await expect(controller.convert(request, '11634', body)).rejects.toThrow('Initial production statuses are not configured');
  });
  it('preserves auth and request validation', async () => {
    const { controller, repository } = setup();
    await expect(controller.convert({}, '11634', body)).rejects.toThrow('Authentication required');
    await expect(controller.convert(request, 'invalid', body)).rejects.toThrow('CRM request conversion payload is invalid');
    expect(repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('retains assigned scope for managers', async () => {
    const { controller, repository } = setup();
    await controller.convert({ ...request, user: { ...request.user!, role: 'manager' } }, '11634', body);
    expect(repository.convertCrmRequestToProduction).toHaveBeenCalledWith(expect.objectContaining({ scope: { mode: 'assigned', userId: 3 } }));
  });
  it('presyncs an ACTIVE request and blocks conversion on blocked products', async () => {
    const { controller, repository, productSync } = setup({}, 'active');
    productSync.syncForOrderId.mockResolvedValue({ status: 'blocked', reason: 'BITRIX24_PRODUCT_UNMAPPED' });

    await expect(controller.convert(request, '11634', body)).rejects.toMatchObject({
      statusCode: 409, code: 'BITRIX24_PRODUCTS_BLOCKED',
      message: 'Bitrix24 product rows are blocked: BITRIX24_PRODUCT_UNMAPPED',
    });
    expect(productSync.syncForOrderId).toHaveBeenCalledTimes(1);
    expect(repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('rejects a skipped required refresh while the request is still active', async () => {
    const { controller, repository, productSync } = setup({}, 'active');
    productSync.syncForOrderId.mockResolvedValue({ status: 'skipped', reason: null });
    // The link re-read still shows an active request — a stale 'ready'
    // certificate must not convert.
    repository.findRequestLinkByOrderId
      .mockResolvedValueOnce({ state: 'active' })
      .mockResolvedValueOnce({ state: 'active' });

    await expect(controller.convert(request, '11634', body)).rejects.toMatchObject({
      statusCode: 409, code: 'BITRIX24_PRODUCT_SYNC_FAILED',
    });
    expect(repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('tolerates a skipped refresh only when the request converted meanwhile', async () => {
    const { controller, repository, productSync } = setup({}, 'active');
    productSync.syncForOrderId.mockResolvedValue({ status: 'skipped', reason: null });
    repository.findRequestLinkByOrderId
      .mockResolvedValueOnce({ state: 'active' })
      .mockResolvedValueOnce({ state: 'converted' });

    await expect(controller.convert(request, '11634', body)).resolves.toEqual({ orderId: 11634 });
  });
  it('never presyncs a converted or unknown request — idempotent replay only', async () => {
    const { controller, repository, productSync } = setup({}, 'converted');
    await expect(controller.convert(request, '11634', body)).resolves.toEqual({ orderId: 11634 });
    expect(productSync.syncForOrderId).not.toHaveBeenCalled();

    const missing = setup({}, null);
    await expect(missing.controller.convert(request, '11634', body)).rejects.toMatchObject({
      statusCode: 404, code: 'ORDER_NOT_FOUND',
    });
    expect(missing.productSync.syncForOrderId).not.toHaveBeenCalled();
    expect(missing.repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('performs the scoped link read before any presync mutation', async () => {
    const { controller, repository, productSync } = setup({}, 'active');
    const manager = { ...request, user: { ...request.user!, role: 'manager' } };
    await controller.convert(manager, '11634', body);
    // Scope is computed from the caller and passed to the link lookup BEFORE
    // productSync.syncForOrderId could be invoked.
    expect(repository.findRequestLinkByOrderId).toHaveBeenNthCalledWith(
      1, 11634, { mode: 'assigned', userId: 3 },
    );
  });
});
