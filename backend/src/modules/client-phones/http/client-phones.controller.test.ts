import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { ClientPhoneService } from '../application/client-phone.service';
import {
  ClientPhonesController,
  parseClientPhoneId,
  parseCreateClientPhoneRequest,
  parseDeleteClientPhoneRequest,
  parseUpdateClientPhoneRequest,
} from './client-phones.controller';
import type { ClientPhonesRuntimeConfigService } from './client-phones-runtime-config.service';

describe('ClientPhonesController', () => {
  it('fails closed when client phones API feature flag is disabled', async () => {
    const controller = createController({ flags: { clientPhonesEnabled: false } });

    await expect(
      controller.create(request(), {
        clientId: 1,
        phoneNumber: '+7 700 000 01 01',
        idempotencyKey: 'client-phone-create-test',
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'clientPhones' },
    } satisfies Partial<ApiError>);
  });

  it('parses and normalizes create/update/delete payloads', () => {
    expect(
      parseCreateClientPhoneRequest({
        clientId: 1,
        phoneNumber: '  +7 700 000 01 01  ',
        isPrimary: true,
        refKey1c: '',
        idempotencyKey: 'client-phone-create-test',
      }),
    ).toEqual({
      clientId: 1,
      phoneNumber: '+7 700 000 01 01',
      phoneType: 'mobile',
      isPrimary: true,
      refKey1c: null,
      idempotencyKey: 'client-phone-create-test',
    });

    expect(
      parseUpdateClientPhoneRequest({
        clientId: 1,
        isPrimary: false,
        idempotencyKey: 'client-phone-update-test',
      }),
    ).toEqual({
      clientId: 1,
      isPrimary: false,
      idempotencyKey: 'client-phone-update-test',
    });

    expect(parseDeleteClientPhoneRequest({ idempotencyKey: 'client-phone-delete-test' })).toEqual({
      idempotencyKey: 'client-phone-delete-test',
    });
  });

  it('rejects invalid ids and guard-only update payloads', () => {
    expect(() => parseClientPhoneId('0')).toThrow(ApiError);
    expect(() =>
      parseUpdateClientPhoneRequest({
        clientId: 1,
        idempotencyKey: 'client-phone-update-test',
      }),
    ).toThrow(ApiError);
  });
});

describe('the owner of a phone while merges of clients are on', () => {
  it('a change or a delete without the client of the form is refused before the service; with it, or with merges off, it goes on', async () => {
    const on = createController({ flags: { clientPhonesEnabled: true, ownerRequired: true } });
    await expect(on.update(request() as never, '10', { phoneType: 'work', idempotencyKey: 'client-phone-update-test' })).rejects.toMatchObject({ statusCode: 422 });
    await expect(on.delete(request() as never, '10', { idempotencyKey: 'client-phone-delete-test' })).rejects.toMatchObject({ statusCode: 422 });
    // With the client, the service is reached (the test service throws its own error).
    await expect(on.delete(request() as never, '10', { idempotencyKey: 'client-phone-delete-test', clientId: 1 })).rejects.toThrow('delete should not be called');
    await expect(on.update(request() as never, '10', { clientId: 1, phoneType: 'work', idempotencyKey: 'client-phone-update-test' })).rejects.toThrow('update should not be called');
    const off = createController({ flags: { clientPhonesEnabled: true, ownerRequired: false } });
    await expect(off.delete(request() as never, '10', { idempotencyKey: 'client-phone-delete-test' })).rejects.toThrow('delete should not be called');
  });
});

function createController(input: { flags: { clientPhonesEnabled: boolean; ownerRequired?: boolean } }) {
  const service = {
    create: async () => {
      throw new Error('create should not be called');
    },
    update: async () => {
      throw new Error('update should not be called');
    },
    delete: async () => {
      throw new Error('delete should not be called');
    },
  } as unknown as ClientPhoneService;

  const runtimeConfig = {
    getFeatureFlags: () => input.flags,
  } as ClientPhonesRuntimeConfigService;

  return new ClientPhonesController(service, runtimeConfig);
}

function request() {
  return {
    user: currentUser(),
    requestId: 'request-1',
  };
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: [],
  };
}
