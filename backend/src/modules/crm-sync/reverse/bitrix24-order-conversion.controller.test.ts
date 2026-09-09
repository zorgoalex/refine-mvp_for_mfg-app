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

function setup(overrides: Partial<BackendEnv> = {}) {
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
  const repository = { convertCrmRequestToProduction: vi.fn().mockResolvedValue({ orderId: 11634 }) };
  return { repository, controller: new Bitrix24OrderConversionController(repository as never, config) };
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
  ])('keeps disabled/read-only deadline writes blocked: %j', (flags) => {
    const { controller, repository } = setup(flags);
    expect(() => controller.convert(request, '11634', body)).toThrow('Production deadline initialization is unavailable');
    expect(repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('preserves initial status validation', () => {
    const { controller } = setup({ BACKEND_ORDER_INITIAL_STATUS_CODE: '' });
    expect(() => controller.convert(request, '11634', body)).toThrow('Initial production statuses are not configured');
  });
  it('preserves auth and request validation', () => {
    const { controller, repository } = setup();
    expect(() => controller.convert({}, '11634', body)).toThrow('Authentication required');
    expect(() => controller.convert(request, 'invalid', body)).toThrow('CRM request conversion payload is invalid');
    expect(repository.convertCrmRequestToProduction).not.toHaveBeenCalled();
  });
  it('retains assigned scope for managers', async () => {
    const { controller, repository } = setup();
    await controller.convert({ ...request, user: { ...request.user!, role: 'manager' } }, '11634', body);
    expect(repository.convertCrmRequestToProduction).toHaveBeenCalledWith(expect.objectContaining({ scope: { mode: 'assigned', userId: 3 } }));
  });
});
