import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { PaymentRepositoryPort } from './payment-command.types';
import { PaymentService } from './payment.service';

describe('PaymentService', () => {
  it('requires payment permissions before delegating commands', async () => {
    const service = new PaymentService({ payments: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.create({
        currentUser: viewer,
        dto: { orderId: 1, typePaidId: 1, amount: 10, paymentDate: '2026-05-01' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('delegates allowed create/update/delete commands to repository', async () => {
    const calls: string[] = [];
    const service = new PaymentService({
      payments: createRepository({
        async createPayment(command) {
          calls.push(`create:${command.dto.orderId}`);
          return mutationResult();
        },
        async updatePayment(command) {
          calls.push(`update:${command.paymentId}`);
          return mutationResult();
        },
        async deletePayment(command) {
          calls.push(`delete:${command.paymentId}`);
          return { paymentId: command.paymentId, order: mutationResult().order, deleted: true };
        },
      }),
    });
    const admin = currentUser('admin');

    await service.create({
      currentUser: admin,
      dto: { orderId: 1, typePaidId: 1, amount: 10, paymentDate: '2026-05-01' },
    });
    await service.update({ currentUser: admin, paymentId: 2, dto: { amount: 20 } });
    await service.delete({ currentUser: admin, paymentId: 2 });

    expect(calls).toEqual(['create:1', 'update:2', 'delete:2']);
  });
});

function createRepository(overrides: Partial<PaymentRepositoryPort> = {}): PaymentRepositoryPort {
  return {
    async createPayment() {
      throw new Error('createPayment should not be called');
    },
    async updatePayment() {
      throw new Error('updatePayment should not be called');
    },
    async deletePayment() {
      throw new Error('deletePayment should not be called');
    },
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role']): CurrentUser {
  return {
    id: `${role}-id`,
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function mutationResult() {
  return {
    payment: {
      paymentId: 2,
      orderId: 1,
      typePaidId: 1,
      amount: 10,
      paymentDate: '2026-05-01',
      notes: null,
      refKey1c: null,
      createdBy: 1,
      editedBy: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: null,
    },
    order: {
      orderId: 1,
      paidAmount: 10,
      debtAmount: 90,
      paymentDate: '2026-05-01',
      paymentStatusId: 2,
      version: 2,
    },
  };
}

