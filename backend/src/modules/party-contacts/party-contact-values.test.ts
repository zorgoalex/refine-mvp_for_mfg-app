import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { OnecCounterpartyContact } from '../onec-agent/onec-catalog-reader';
import { onecContactValues } from './onec-contact-values';
import { maskPartyContact, normalizePartyContact, planContactSet, type StoredContact } from './party-contact-values';
import { PARTY_ONEC_CONTACTS_MAX, type PartyContactInput } from './party-contacts';

const KINDS = ['phone', 'email', 'telegram', 'address'] as const;
const stored = (patch: Partial<StoredContact> & Pick<StoredContact, 'contactId' | 'kind' | 'valueNormalized'>): StoredContact =>
  ({ value: patch.valueNormalized, isPrimary: false, position: 99, origin: 'onec', available: true, ...patch });
const line = (patch: Partial<PartyContactInput> & Pick<PartyContactInput, 'kind' | 'value'>): PartyContactInput =>
  ({ contactId: null, isPrimary: false, note: null, ...patch });
const codeOf = (call: () => unknown) => {
  try { call(); return 'ok'; } catch (error) { return error instanceof ApiError ? error.code : String(error); }
};

describe('party contact values', () => {
  it('normalizes addresses by their words and masks them by length only', () => {
    expect(normalizePartyContact('address', '  Алматы,\n ул.  Тестовая ')).toBe('алматы, ул. тестовая');
    expect(codeOf(() => normalizePartyContact('address', 'x'.repeat(501)))).toBe('PARTY_CONTACT_INVALID');
    expect(maskPartyContact('address', 'алматы')).toBe('адрес (6)');
    expect(normalizePartyContact('phone', '8 701 555 01 01')).toBe('77015550101');
    // 200 for every other kind (the DB limit), 500 for an address: a validation error, never a CHECK violation.
    expect(codeOf(() => normalizePartyContact('email', `${'a'.repeat(190)}@test.kz.kz`))).toBe('PARTY_CONTACT_INVALID');
    expect(normalizePartyContact('address', 'а'.repeat(500))).toHaveLength(500);
  });

  it('keeps unnamed rows of 1C, lets a named one move only its flag, refuses an edit of its value', () => {
    const rows = [stored({ contactId: 1, kind: 'phone', valueNormalized: '77015551101', isPrimary: true })];
    const kept = planContactSet([line({ kind: 'email', value: 'a@b.kz' })], rows, KINDS, 'поставщика');
    expect(kept.onec).toEqual([{ contactId: 1, isPrimary: true, position: 99 }]);
    expect(kept.own).toMatchObject([{ kind: 'email', isPrimary: true }]);
    const own = planContactSet([line({ kind: 'phone', value: '87015552222', isPrimary: true })], rows, KINDS, 'поставщика');
    expect(own.onec).toEqual([{ contactId: 1, isPrimary: false, position: 99 }]);
    expect(own.own[0].isPrimary).toBe(true);
    expect(codeOf(() => planContactSet([line({ contactId: 1, kind: 'phone', value: '87015550000' })], rows, KINDS, 'поставщика'))).toBe('PARTY_CONTACT_ONEC_READONLY');
    expect(codeOf(() => planContactSet([line({ kind: 'phone', value: '+7 701 555 11 01' })], rows, KINDS, 'поставщика'))).toBe('PARTY_CONTACT_DUPLICATE');
  });

  it('a row of 1C whose presentation does not read as a number is accepted back unchanged, refused when edited', () => {
    const rows = [stored({ contactId: 1, kind: 'phone', value: 'Отдел продаж: +7 701 555 11 01 (с 9 до 18)', valueNormalized: '77015551101' })];
    expect(planContactSet([line({ contactId: 1, kind: 'phone', value: 'Отдел продаж: +7 701 555 11 01 (с 9 до 18)', isPrimary: true })], rows, KINDS, 'поставщика').onec)
      .toEqual([{ contactId: 1, isPrimary: true, position: 0 }]);
    expect(codeOf(() => planContactSet([line({ contactId: 1, kind: 'phone', value: 'Отдел продаж' })], rows, KINDS, 'поставщика'))).toBe('PARTY_CONTACT_ONEC_READONLY');
  });

  it('a hidden row of 1C takes no part: naming it is a stale form, and it gives up «основной»', () => {
    const rows = [stored({ contactId: 1, kind: 'phone', valueNormalized: '77015551101', isPrimary: true, available: false })];
    expect(codeOf(() => planContactSet([line({ contactId: 1, kind: 'phone', value: '87015551101' })], rows, KINDS, 'поставщика')))
      .toBe('PARTY_CONTACTS_VERSION_CONFLICT');
    expect(planContactSet([line({ kind: 'phone', value: '87015552222' })], rows, KINDS, 'поставщика')).toMatchObject({ onec: [], own: [{ isPrimary: true }] });
  });

  it('refuses two explicit primaries of a kind, kinds the owner does not keep, and more than 20 own contacts', () => {
    const rows = [stored({ contactId: 1, kind: 'phone', valueNormalized: '77015551101' })];
    expect(codeOf(() => planContactSet([line({ contactId: 1, kind: 'phone', value: '87015551101', isPrimary: true }),
      line({ kind: 'phone', value: '87015552222', isPrimary: true })], rows, KINDS, 'поставщика'))).toBe('PARTY_CONTACT_INVALID');
    expect(codeOf(() => planContactSet([line({ kind: 'address', value: 'Алматы' })], [], ['phone', 'email', 'telegram'], 'производителя'))).toBe('PARTY_CONTACT_INVALID');
    const many = Array.from({ length: 21 }, (_, index) => line({ kind: 'email', value: `user${index}@test.kz` }));
    expect(codeOf(() => planContactSet(many, [], KINDS, 'поставщика'))).toBe('PARTY_CONTACT_INVALID');
  });
});

describe('1C contact values', () => {
  const contact = (lineNo: number, type: OnecCounterpartyContact['type'], fields: Partial<OnecCounterpartyContact>): OnecCounterpartyContact => ({
    counterpartyRefKey: 'k', lineNo, type, typeRaw: null, kindRefKey: null, presentation: null, phoneNumber: null, email: null,
    country: null, region: null, city: null, ...fields,
  });

  it('reads the number field, else the presentation; skips unreadable values; leaves other types out; one value once', () => {
    expect(onecContactValues([
      contact(2, 'phone', { phoneNumber: null, presentation: '8 (701) 555-11-01' }),
      contact(1, 'phone', { phoneNumber: '+77015551101', presentation: '+7 701 555 11 01' }),
      contact(3, 'phone', { phoneNumber: 'внутренний 12' }),
      contact(4, 'other', { presentation: 'skype' }),
      contact(5, 'email', { email: 'Sales@Test.KZ' }),
      contact(6, 'phone', { phoneNumber: '87015552202', presentation: 'Склад: 8 701 555 99 99' }),
    ])).toEqual({
      values: [
        { kind: 'phone', value: '+7 701 555 11 01', valueNormalized: '77015551101' },
        { kind: 'email', value: 'sales@test.kz', valueNormalized: 'sales@test.kz' },
        // A presentation with another number (or none) is not shown: the number itself is.
        { kind: 'phone', value: '+7 701 555 22 02', valueNormalized: '77015552202' },
      ],
      skipped: 1,
    });
  });

  it(`takes at most ${PARTY_ONEC_CONTACTS_MAX} values; the rest count as skipped`, () => {
    const many = Array.from({ length: PARTY_ONEC_CONTACTS_MAX + 2 }, (_, index) => contact(index + 1, 'email', { email: `u${index}@test.kz` }));
    expect(onecContactValues(many)).toMatchObject({ skipped: 2 });
    expect(onecContactValues(many).values).toHaveLength(PARTY_ONEC_CONTACTS_MAX);
  });
});
