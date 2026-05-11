import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientPhonesApi, validateClientPhoneId } from './clientPhonesApi';
import type { ClientPhoneDto } from './types/clientPhoneApi.types';

describe('clientPhonesApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates, updates, and deletes client phones through /api/v1/client-phones', async () => {
    const phone = clientPhoneDto();
    const fetchMock = mockFetch(
      { phone, requestId: 'request-1' },
      { phone: { ...phone, phoneNumber: '+7 700 000 02 02' }, requestId: 'request-2' },
      { phoneId: 10, clientId: 1, deleted: true, requestId: 'request-3' },
    );

    await expect(
      clientPhonesApi.create({
        clientId: 1,
        phoneNumber: '+7 700 000 01 01',
        isPrimary: false,
      }),
    ).resolves.toEqual(phone);
    await expect(
      clientPhonesApi.update(10, { phoneNumber: '+7 700 000 02 02' }),
    ).resolves.toMatchObject({
      phoneNumber: '+7 700 000 02 02',
    });
    await expect(clientPhonesApi.delete(10)).resolves.toMatchObject({
      phoneId: 10,
      deleted: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/client-phones');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(
      'client-phone-create:uuid-1',
    );
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/client-phones/10');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/client-phones/10');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE');
    expect(String(fetchMock.mock.calls[2][1]?.body)).toContain(
      'client-phone-delete:uuid-1',
    );
  });

  it('rejects invalid phone ids before fetch', async () => {
    const fetchMock = mockFetch({ phone: clientPhoneDto(), requestId: 'request-1' });

    expect(() => validateClientPhoneId(0)).toThrow('Invalid phoneId');
    await expect(clientPhonesApi.update(1.5, { isPrimary: false })).rejects.toThrow(
      'Invalid phoneId',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function clientPhoneDto(overrides: Partial<ClientPhoneDto> = {}): ClientPhoneDto {
  return {
    phoneId: 10,
    clientId: 1,
    phoneNumber: '+7 700 000 01 01',
    phoneType: 'mobile',
    isPrimary: false,
    refKey1c: null,
    createdBy: 1,
    editedBy: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}
