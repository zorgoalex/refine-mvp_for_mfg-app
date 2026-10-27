import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import { maskPartyContact, normalizePartyContact, planContactSet, type StoredContact } from './party-contact-values';
import { CLIENT_EXTRA_CONTACT_KINDS, PARTY_CONFIG, type PartyContactInput } from './party-contacts';

const CLIENT = PARTY_CONFIG.client;
const stored = (patch: Partial<StoredContact> & Pick<StoredContact, 'contactId' | 'kind' | 'valueNormalized'>): StoredContact =>
  ({ value: patch.valueNormalized, isPrimary: false, position: 0, origin: 'erp', available: true, note: null, ...patch });
const line = (patch: Partial<PartyContactInput> & Pick<PartyContactInput, 'kind' | 'value'>): PartyContactInput =>
  ({ contactId: null, isPrimary: false, note: null, ...patch });
const codeOf = (call: () => unknown) => {
  try { call(); return 'ok'; } catch (error) { return error instanceof ApiError ? error.code : String(error); }
};

describe('client messenger kinds (migration 269)', () => {
  it('keeps the messengers for clients only', () => {
    expect(CLIENT.kinds).toEqual(['email', 'telegram', 'whatsapp', 'viber', 'instagram', 'other']);
    expect(CLIENT.extraKinds).toEqual(CLIENT_EXTRA_CONTACT_KINDS);
    expect(PARTY_CONFIG.supplier.extraKinds).toEqual([]);
    expect(codeOf(() => planContactSet([line({ kind: 'whatsapp', value: '87015550101' })], [], PARTY_CONFIG.vendor.kinds, 'производителя')))
      .toBe('PARTY_CONTACT_INVALID');
  });

  it('normalizes WhatsApp / Viber as a phone, Instagram as an account, «Другое» by its words', () => {
    expect(normalizePartyContact('whatsapp', '+7 (701) 555-01-01')).toBe('77015550101');
    expect(normalizePartyContact('viber', '8 701 555 01 01')).toBe('77015550101');
    expect(codeOf(() => normalizePartyContact('whatsapp', 'нет'))).toBe('PARTY_CONTACT_INVALID');
    expect(normalizePartyContact('instagram', '@Mebel.KZ_shop')).toBe('mebel.kz_shop');
    expect(normalizePartyContact('instagram', 'https://www.instagram.com/mebel_kz/')).toBe('mebel_kz');
    expect(codeOf(() => normalizePartyContact('instagram', 'two words'))).toBe('PARTY_CONTACT_INVALID');
    expect(normalizePartyContact('other', '  vk.com/Mebel   KZ ')).toBe('vk.com/mebel kz');
  });

  it('reports a repeated contact by its line, without the value', () => {
    let caught: unknown;
    try {
      planContactSet([line({ kind: 'whatsapp', value: '8 701 555 01 01' }), line({ kind: 'whatsapp', value: '+77015550101' })], [], CLIENT.kinds, 'клиента');
    } catch (error) { caught = error; }
    expect((caught as ApiError).code).toBe('PARTY_CONTACT_DUPLICATE');
    expect(JSON.stringify({ m: (caught as ApiError).message, d: (caught as ApiError).details })).not.toMatch(/555/);
    expect((caught as ApiError).message).toContain('строке 2');
  });

  it('masks every new kind in the audit', () => {
    expect(maskPartyContact('whatsapp', '77015550101')).not.toContain('5550101');
    expect(maskPartyContact('instagram', 'mebel_kz')).toBe('@me***');
    expect(maskPartyContact('other', 'vk.com/mebel')).toBe('другое (12)');
  });

  it('needs a label for «Другое»', () => {
    expect(codeOf(() => planContactSet([line({ kind: 'other', value: 'vk.com/mebel' })], [], CLIENT.kinds, 'клиента'))).toBe('PARTY_CONTACT_INVALID');
    expect(planContactSet([line({ kind: 'other', value: 'vk.com/mebel', note: ' VK ' })], [], CLIENT.kinds, 'клиента').own[0])
      .toMatchObject({ kind: 'other', note: 'VK', isPrimary: true });
  });

  it('with the kinds switched off keeps a stored contact as it is, refuses a new or changed one, lets it go', () => {
    const rows = [stored({ contactId: 5, kind: 'whatsapp', valueNormalized: '77015550101' }),
      stored({ contactId: 6, kind: 'other', valueNormalized: 'vk.com/mebel', note: 'VK' })];
    const frozen = CLIENT.extraKinds;
    const kept = planContactSet([line({ contactId: 5, kind: 'whatsapp', value: '8 701 555 01 01' }),
      line({ contactId: 6, kind: 'other', value: 'vk.com/mebel', note: 'VK' }), line({ kind: 'email', value: 'a@b.kz' })],
    rows, CLIENT.kinds, 'клиента', frozen);
    expect(kept.own.map((row) => row.contactId)).toEqual([5, 6, null]);
    expect(codeOf(() => planContactSet([line({ kind: 'whatsapp', value: '87015550102' })], rows, CLIENT.kinds, 'клиента', frozen)))
      .toBe('PARTY_CONTACT_INVALID');
    expect(codeOf(() => planContactSet([line({ contactId: 5, kind: 'whatsapp', value: '87015550102' })], rows, CLIENT.kinds, 'клиента', frozen)))
      .toBe('PARTY_CONTACT_INVALID');
    expect(codeOf(() => planContactSet([line({ contactId: 6, kind: 'other', value: 'vk.com/mebel', note: 'ВКонтакте' })], rows, CLIENT.kinds, 'клиента', frozen)))
      .toBe('PARTY_CONTACT_INVALID');
    expect(planContactSet([line({ kind: 'email', value: 'a@b.kz' })], rows, CLIENT.kinds, 'клиента', frozen).own).toHaveLength(1);
  });
});
