import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPhone = vi.fn();
const updatePhone = vi.fn();
const deletePhone = vi.fn();

describe('dataProvider backend client phones mutation routing', () => {
  beforeEach(() => {
    vi.resetModules();
    createPhone.mockReset();
    updatePhone.mockReset();
    deletePhone.mockReset();
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: false,
        useBackendOrdersWrite: false,
        useBackendPayments: false,
        useBackendClientPhones: true,
        useBackendProductionActions: true,
        useBackendOrderExport: false,
        useBackendUsers: false,
        useBackendVlm: false,
        useBackendReferences: false,
        enableLegacyHasura: true,
      },
    }));
    vi.doMock('../api/clientPhonesApi', () => ({
      clientPhonesApi: {
        create: createPhone,
        update: updatePhone,
        delete: deletePhone,
      },
    }));
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', '/v1/graphql');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.doUnmock('../config/featureFlags');
    vi.doUnmock('../api/clientPhonesApi');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('routes client_phones create/update/delete to backend and maps legacy field names', async () => {
    const phone = backendPhone();
    createPhone.mockResolvedValue(phone);
    updatePhone.mockResolvedValue({ ...phone, isPrimary: false });
    deletePhone.mockResolvedValue({
      phoneId: 10,
      clientId: 1,
      deleted: true,
      requestId: 'request-3',
    });
    const { dataProvider } = await import('./dataProvider');
    const provider = dataProvider('');

    await expect(
      provider.create({
        resource: 'client_phones',
        variables: {
          client_id: 1,
          phone_number: ' +7 700 000 01 01 ',
          phone_type: 'mobile',
          is_primary: false,
        },
      }),
    ).resolves.toMatchObject({
      data: {
        phone_id: 10,
        client_id: 1,
        phone_number: '+7 700 000 01 01',
        is_primary: true,
      },
    });
    await provider.update({
      resource: 'client_phones',
      id: 10,
      variables: { client_id: 1, is_primary: false },
      meta: { forceHasuraMutation: true },
    });
    await provider.deleteOne({ resource: 'client_phones', id: 10 });

    expect(createPhone).toHaveBeenCalledWith({
      clientId: 1,
      phoneNumber: '+7 700 000 01 01',
      phoneType: 'mobile',
      isPrimary: false,
      refKey1c: null,
    });
    expect(updatePhone).toHaveBeenCalledWith(10, { clientId: 1, isPrimary: false });
    expect(deletePhone).toHaveBeenCalledWith(10);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

function backendPhone() {
  return {
    phoneId: 10,
    clientId: 1,
    phoneNumber: '+7 700 000 01 01',
    phoneType: 'mobile',
    isPrimary: true,
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: null,
  };
}
