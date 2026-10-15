import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { DowelingService } from '../application/doweling.service';
import {
  DowelingController,
  parseCreateDowelingRequest,
  parseDowelingOrderId,
  parseUpdateDowelingRequest,
} from './doweling.controller';
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

  it('parseCreateDowelingRequest passes the order to link (quick-create from an order)', () => {
    expect(parseCreateDowelingRequest({ ...validBody, orderId: 101 })).toMatchObject({ orderId: 101 });
    expect(() => parseCreateDowelingRequest({ ...validBody, orderId: 0 })).toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});

const validUpdate = {
  expectedVersion: 3,
  dowelingOrderName: '  Тест присадка  ',
  dowelingOrderDate: '2026-10-15',
  paymentStatusId: 1,
  designEngineerId: 3,
  productionStatusId: null,
  operatorId: 3,
  issueDate: null,
  paymentDate: null,
  partsCount: 12,
  totalAmount: 1000.005,
  finalAmount: 950,
  discount: 50,
  surcharge: 0,
  paidAmount: 0,
  linkCadFile: '',
  linkPdfFile: ' https://example.test/a.pdf ',
  refKey1c: 'A1B2C3D4-0000-4000-8000-000000000001',
  isActive: true,
  orderIds: [102, 101],
  baseOrderIds: [101],
};

describe('PATCH /doweling-orders/:id payload', () => {
  it('normalizes a valid body: trimmed name, rounded amounts, empty link → null, lower-case 1C key', () => {
    expect(parseUpdateDowelingRequest(validUpdate)).toMatchObject({
      dowelingOrderName: 'Тест присадка',
      totalAmount: 1000.01,
      linkCadFile: null,
      linkPdfFile: 'https://example.test/a.pdf',
      refKey1c: 'a1b2c3d4-0000-4000-8000-000000000001',
      orderIds: [102, 101],
    });
  });

  it.each([
    ['an inactive doweling order with orders', { isActive: false }],
    ['duplicate orders', { orderIds: [101, 101] }],
    ['a missing expected version', { expectedVersion: undefined }],
    ['missing base orders', { baseOrderIds: undefined }],
    ['a negative amount', { discount: -1 }],
    ['an impossible date', { paymentDate: '2026-02-30' }],
    ['a 1C key that is not a UUID', { refKey1c: 'not-a-uuid' }],
    ['an unknown field', { order_id: 5 }],
    ['more than 50 orders', { orderIds: Array.from({ length: 51 }, (_, index) => index + 1) }],
  ])('rejects %s with 422', (_label, patch) => {
    expect(() => parseUpdateDowelingRequest({ ...validUpdate, ...patch })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
    );
  });

  it('accepts an inactive doweling order without orders', () => {
    expect(parseUpdateDowelingRequest({ ...validUpdate, isActive: false, orderIds: [] })).toMatchObject({ isActive: false, orderIds: [] });
  });

  it('parses the doweling order id of the path', () => {
    expect(parseDowelingOrderId('42')).toBe(42);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() => parseDowelingOrderId(bad)).toThrow(expect.objectContaining({ statusCode: 422 }));
    }
  });

  it('update is behind the doweling commands flag and passes the parsed command to the service', async () => {
    const off = createController({ flags: { dowelingCommandsEnabled: false } });
    await expect(off.update(request(), '42', validUpdate)).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });

    const updateDowelingOrder = vi.fn().mockResolvedValue({ changed: true });
    const on = createController({ flags: { dowelingCommandsEnabled: true }, service: { updateDowelingOrder } });
    await on.update(request(), '42', validUpdate);
    expect(updateDowelingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ dowelingOrderId: 42, requestId: 'r', dto: expect.objectContaining({ expectedVersion: 3 }) }),
    );
  });

  it('update without an authenticated user is 401', async () => {
    const on = createController({ flags: { dowelingCommandsEnabled: true }, service: { updateDowelingOrder: vi.fn() } });
    await expect(on.update({ requestId: 'r' } as RequestWithCurrentUser, '42', validUpdate)).rejects.toMatchObject({ statusCode: 401 });
  });
});

function createController(input: { flags: { dowelingCommandsEnabled: boolean }; service?: Record<string, unknown> }) {
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
