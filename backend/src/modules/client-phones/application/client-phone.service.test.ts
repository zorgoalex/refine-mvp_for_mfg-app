import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { ClientPhoneRepositoryPort } from './client-phone.types';
import { ClientPhoneService } from './client-phone.service';

describe('ClientPhoneService', () => {
  it.each(['superadmin', 'admin', 'top_manager', 'manager', 'operator'] as const)(
    'allows %s to create/update/delete client phones',
    async (role) => {
      const calls: string[] = [];
      const service = new ClientPhoneService({
        clientPhones: createRepository({
          async createClientPhone(command) {
            calls.push(`${role}:create:${command.dto.clientId}`);
            return phoneResponse();
          },
          async updateClientPhone(command) {
            calls.push(`${role}:update:${command.phoneId}`);
            return phoneResponse();
          },
          async deleteClientPhone(command) {
            calls.push(`${role}:delete:${command.phoneId}`);
            return deleteResponse(command.phoneId);
          },
        }),
      });
      const user = currentUser(role);

      await service.create({
        currentUser: user,
        dto: createRequest(),
      });
      await service.update({
        currentUser: user,
        phoneId: 10,
        dto: { phoneNumber: '+7 700 000 02 02', idempotencyKey: 'client-phone-update-test' },
      });
      await service.delete({
        currentUser: user,
        phoneId: 10,
        dto: { idempotencyKey: 'client-phone-delete-test' },
      });

      expect(calls).toEqual([`${role}:create:1`, `${role}:update:10`, `${role}:delete:10`]);
    },
  );

  it.each(['worker', 'viewer'] as const)('denies %s client phone commands', async (role) => {
    const service = new ClientPhoneService({ clientPhones: createRepository() });
    const user = currentUser(role);

    await expect(
      service.create({
        currentUser: user,
        dto: createRequest(),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });
});

function createRepository(
  overrides: Partial<ClientPhoneRepositoryPort> = {},
): ClientPhoneRepositoryPort {
  return {
    async createClientPhone() {
      throw new Error('createClientPhone should not be called');
    },
    async updateClientPhone() {
      throw new Error('updateClientPhone should not be called');
    },
    async deleteClientPhone() {
      throw new Error('deleteClientPhone should not be called');
    },
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role']): CurrentUser {
  return {
    id: '1',
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function createRequest() {
  return {
    clientId: 1,
    phoneNumber: '+7 700 000 01 01',
    phoneType: 'mobile' as const,
    isPrimary: true,
    refKey1c: null,
    idempotencyKey: 'client-phone-create-test',
  };
}

function phoneResponse() {
  return {
    phone: {
      phoneId: 10,
      clientId: 1,
      phoneNumber: '+7 700 000 01 01',
      phoneType: 'mobile' as const,
      isPrimary: true,
      refKey1c: null,
      createdBy: 1,
      editedBy: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: null,
    },
    requestId: 'request-1',
  };
}

function deleteResponse(phoneId: number) {
  return {
    phoneId,
    clientId: 1,
    deleted: true as const,
    requestId: 'request-1',
  };
}
