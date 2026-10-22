import { describe, expect, it } from 'vitest';
import { ClientContactsController } from './client-contacts.controller';

describe('ClientContactsController phones save', () => {
  it('returns the stored command answer as it is (a repeat gets the same result) next to the current row', async () => {
    const stored = { clientId: 1, phones: [], created: 1, updated: 0, deleted: 0, requestId: 'first-request' };
    const now = { client: { id: 1, name: 'Тест', isActive: true, personType: null }, phones: [], contacts: [], contactsVersion: 0, updatedAt: null };
    const controller = new ClientContactsController(
      { row: async () => now } as never,
      {} as never,
      { replaceSet: async () => stored } as never,
      { getFeatureFlags: () => ({ clientPhonesEnabled: true }) } as never,
    );
    const request = { user: { id: '11', permissions: ['clients.contacts.manage'] }, requestId: 'repeat-request' } as never;
    const answer = await controller.replacePhones('1', { idempotencyKey: 'key-12345678', expected: [], phones: [] }, request);
    expect(answer).toEqual({ result: stored, row: now });
  });

  it('refuses while the client phones commands are off', async () => {
    const controller = new ClientContactsController({} as never, {} as never, {} as never, { getFeatureFlags: () => ({ clientPhonesEnabled: false }) } as never);
    await expect(controller.replacePhones('1', {}, {} as never)).rejects.toMatchObject({ statusCode: 503, code: 'CLIENT_PHONES_DISABLED' });
  });
});
