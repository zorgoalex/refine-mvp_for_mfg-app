import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { DowelingService } from '../application/doweling.service';
import { DowelingController, parseCreateDowelingRequest } from './doweling.controller';
import type { DowelingRuntimeConfigService } from './doweling-runtime-config.service';

const validBody = {
  dowelingOrderName: 'Тест присадка',
  designEngineerId: 3,
  paymentStatusId: 1,
  idempotencyKey: 'dwl-key-0001',
};

describe('DowelingController', () => {
  it('fails closed with 503 SERVICE_UNAVAILABLE when the flag is off', async () => {
    const controller = createController({ flags: { dowelingCommandsEnabled: false } });
    await expect(controller.create(request(), validBody)).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'dowelingCommands' },
    } satisfies Partial<ApiError>);
  });

  it('delegates a valid request to the service when the flag is on', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ dowelingOrder: { dowelingOrderId: 7, dowelingOrderName: 'Тест присадка', version: 0 }, requestId: 'r' });
    const controller = createController({ flags: { dowelingCommandsEnabled: true }, service: { createDowelingOrder: create } });
    const res = await controller.create(request(), validBody);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ dto: expect.objectContaining({ designEngineerId: 3 }) }));
    expect(res.dowelingOrder.dowelingOrderId).toBe(7);
  });

  it('parseCreateDowelingRequest rejects empty name with 422', () => {
    expect(() => parseCreateDowelingRequest({ ...validBody, dowelingOrderName: '   ' })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
    );
  });

  it('parseCreateDowelingRequest rejects an impossible calendar date with 422', () => {
    for (const bad of ['2026-99-99', '2026-02-30', '2026-13-01']) {
      expect(() => parseCreateDowelingRequest({ ...validBody, dowelingOrderDate: bad })).toThrow(
        expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
      );
    }
  });

  it('parseCreateDowelingRequest accepts a real ISO date', () => {
    expect(parseCreateDowelingRequest({ ...validBody, dowelingOrderDate: '2026-02-28' })).toMatchObject({
      dowelingOrderDate: '2026-02-28',
    });
  });

  it('parseCreateDowelingRequest trims name and passes a valid body', () => {
    expect(parseCreateDowelingRequest({ ...validBody, dowelingOrderName: '  Тест присадка  ' })).toMatchObject({
      dowelingOrderName: 'Тест присадка',
      designEngineerId: 3,
      paymentStatusId: 1,
      idempotencyKey: 'dwl-key-0001',
    });
  });
});

function createController(input: { flags: { dowelingCommandsEnabled: boolean }; service?: { createDowelingOrder: unknown } }) {
  const service = (input.service ?? {
    createDowelingOrder: async () => {
      throw new Error('createDowelingOrder should not be called');
    },
  }) as unknown as DowelingService;
  const runtimeConfig = { getFeatureFlags: () => input.flags } as unknown as DowelingRuntimeConfigService;
  return new DowelingController(service, runtimeConfig);
}

function request(): RequestWithCurrentUser {
  return {
    user: { id: '1', username: 'manager', role: 'manager', roleId: 1, permissions: ['doweling.create'] },
    requestId: 'r',
  };
}
