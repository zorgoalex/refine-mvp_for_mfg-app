import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { PaymentService } from '../application/payment.service';
import type { PaymentDto } from '../dto/payment.dto';
import {
  parseCreatePaymentRequest,
  parsePaymentId,
  parseUpdatePaymentRequest,
  PaymentsController,
} from './payments.controller';
import type { PaymentsRuntimeConfigService } from './payments-runtime-config.service';

describe('PaymentsController', () => {
  it('fails closed when payments API feature flag is disabled', async () => {
    const controller = createController({ flags: { paymentsEnabled: false } });

    await expect(
      controller.create({ user: currentUser() }, createPaymentBody()),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'payments' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before service call', async () => {
    const controller = createController({ flags: { paymentsEnabled: true } });

    await expect(controller.create({}, createPaymentBody())).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('delegates create, update, and delete to PaymentService', async () => {
    const payment = paymentDto();
    const calls: string[] = [];
    const controller = createController({
      flags: { paymentsEnabled: true },
      service: {
        async create(command) {
          calls.push(`create:${command.currentUser.id}:${command.dto.orderId}`);
          return { payment, order: orderSummary() };
        },
        async update(command) {
          calls.push(`update:${command.paymentId}:${command.dto.amount}`);
          return { payment, order: orderSummary() };
        },
        async delete(command) {
          calls.push(`delete:${command.paymentId}`);
          return { paymentId: command.paymentId, order: orderSummary(), deleted: true };
        },
      },
    });

    await expect(
      controller.create({ user: currentUser('manager-id') }, createPaymentBody()),
    ).resolves.toEqual({ payment, order: orderSummary() });
    await expect(
      controller.update({ user: currentUser('manager-id') }, '30', { amount: 200 }),
    ).resolves.toEqual({ payment, order: orderSummary() });
    await expect(controller.delete({ user: currentUser('manager-id') }, '30')).resolves.toEqual({
      paymentId: 30,
      order: orderSummary(),
      deleted: true,
    });
    expect(calls).toEqual(['create:manager-id:15', 'update:30:200', 'delete:30']);
  });

  it('validates path ids and request bodies', () => {
    expect(parsePaymentId('42')).toBe(42);
    expect(() => parsePaymentId('0')).toThrow(ApiError);
    expect(() => parseCreatePaymentRequest({ ...createPaymentBody(), amount: 0 })).toThrow(ApiError);
    expect(() => parseUpdatePaymentRequest({ paymentDate: '10.05.2026' })).toThrow(ApiError);
    expect(() => parseUpdatePaymentRequest({})).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { paymentsEnabled: boolean };
  service?: Partial<PaymentService>;
}): PaymentsController {
  const service = {
    async create() {
      throw new Error('create should not be called');
    },
    async update() {
      throw new Error('update should not be called');
    },
    async delete() {
      throw new Error('delete should not be called');
    },
    ...options.service,
  } as unknown as PaymentService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as PaymentsRuntimeConfigService;

  return new PaymentsController(service, runtimeConfig);
}

function currentUser(id = 'admin-id'): CurrentUser {
  return {
    id,
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function createPaymentBody() {
  return {
    orderId: 15,
    typePaidId: 1,
    amount: 100,
    paymentDate: '2026-05-01',
  };
}

function paymentDto(overrides: Partial<PaymentDto> = {}): PaymentDto {
  return {
    paymentId: 30,
    orderId: 15,
    typePaidId: 1,
    amount: 100,
    paymentDate: '2026-05-01',
    notes: null,
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

function orderSummary() {
  return {
    orderId: 15,
    paidAmount: 100,
    debtAmount: 900,
    paymentDate: '2026-05-01',
    paymentStatusId: 2,
    version: 4,
  };
}

