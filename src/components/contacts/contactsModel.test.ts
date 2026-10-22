import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import {
  isContactsApiMissing,
  addDraftRow, changeDraftKind, contactsToDraft, draftToInput, formatContact, isForeignCopy, removeDraftRow, setDraftPrimary, sortContacts,
} from './contactsModel';

const contacts = [
  { contactId: 1, kind: 'email' as const, value: 'a@b.kz', valueNormalized: 'a@b.kz', isPrimary: true, note: null },
  { contactId: 2, kind: 'phone' as const, value: '87015550102', valueNormalized: '77015550102', isPrimary: false, note: 'личный' },
  { contactId: 3, kind: 'phone' as const, value: '87015550101', valueNormalized: '77015550101', isPrimary: true, note: null },
];

describe('employee contacts editor model', () => {
  it('sorts by kind with the primary first and formats values', () => {
    expect(sortContacts(contacts).map((contact) => contact.contactId)).toEqual([3, 2, 1]);
    expect(formatContact(contacts[2])).toBe('+7 701 555 01 01');
    expect(formatContact({ kind: 'telegram', valueNormalized: 'ivan_master' })).toBe('@ivan_master');
  });

  it('keeps one primary per kind when adding, marking, removing and changing kind', () => {
    let rows = contactsToDraft(sortContacts(contacts));
    rows = addDraftRow(rows, 'phone');
    expect(rows[3]).toMatchObject({ contactId: null, kind: 'phone', isPrimary: false });
    rows = addDraftRow(rows, 'telegram');
    expect(rows[4].isPrimary).toBe(true);
    rows = setDraftPrimary(rows, rows[1].rowKey);
    expect(rows.filter((row) => row.kind === 'phone').map((row) => row.isPrimary)).toEqual([false, true, false]);
    rows = removeDraftRow(rows, rows[1].rowKey);
    expect(rows.filter((row) => row.kind === 'phone').map((row) => row.isPrimary)).toEqual([true, false]);
    rows = changeDraftKind(rows, rows[0].rowKey, 'email');
    expect(rows.map((row) => [row.kind, row.isPrimary])).toEqual([['email', false], ['email', true], ['phone', true], ['telegram', true]]);
  });

  it('tells an older backend without the contacts API from a missing employee', () => {
    expect(isContactsApiMissing(new ApiError({ status: 404, code: 'HTTP_404', message: 'Not Found' }))).toBe(true);
    expect(isContactsApiMissing(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'Cannot GET' }))).toBe(true);
    expect(isContactsApiMissing(new ApiError({ status: 404, code: 'EMPLOYEE_NOT_FOUND', message: 'Сотрудник не найден' }))).toBe(false);
    for (const code of ['SUPPLIER_NOT_FOUND', 'VENDOR_NOT_FOUND', 'CLIENT_NOT_FOUND']) {
      expect(isContactsApiMissing(new ApiError({ status: 404, code, message: 'x' }))).toBe(false);
    }
    expect(isContactsApiMissing(new ApiError({ status: 403, code: 'PERMISSION_DENIED', message: 'x' }))).toBe(false);
    expect(isContactsApiMissing(new Error('network'))).toBe(false);
  });

  it('builds the command body, refusing an empty value', () => {
    const rows = contactsToDraft(contacts);
    expect(draftToInput(rows)).toEqual({ contacts: [
      { contactId: 1, kind: 'email', value: 'a@b.kz', isPrimary: true, note: null },
      { contactId: 2, kind: 'phone', value: '87015550102', isPrimary: false, note: 'личный' },
      { contactId: 3, kind: 'phone', value: '87015550101', isPrimary: true, note: null },
    ] });
    expect(draftToInput(addDraftRow(rows, 'email'))).toHaveProperty('error');
  });
});

describe('contacts that came from 1C and addresses', () => {
  const fromOnec = [
    { contactId: 7, kind: 'phone' as const, value: '+7 (701) 555-11-01', valueNormalized: '77015551101', isPrimary: false, note: null, origin: 'onec' as const },
    { contactId: 8, kind: 'address' as const, value: 'Алматы, ул. Тестовая, 1', valueNormalized: 'алматы, ул. тестовая, 1', isPrimary: true, note: null, origin: 'onec' as const },
  ];

  it('a row from 1C cannot be removed or change its kind, but can become «основной»; it is sent back as it is', () => {
    let rows = contactsToDraft(sortContacts([...contacts, ...fromOnec]));
    const onec = rows.find((row) => row.contactId === 7);
    expect(onec?.fromOnec).toBe(true);
    expect(removeDraftRow(rows, onec?.rowKey as string)).toEqual(rows);
    expect(changeDraftKind(rows, onec?.rowKey as string, 'email')).toEqual(rows);
    rows = setDraftPrimary(rows, onec?.rowKey as string);
    const body = draftToInput(rows);
    expect('contacts' in body && body.contacts.find((contact) => contact.contactId === 7)).toEqual({
      contactId: 7, kind: 'phone', value: '+7 (701) 555-11-01', isPrimary: true, note: null,
    });
  });

  it('an address is shown as written and sorted after the other kinds; rows from 1C do not count against the limit', () => {
    expect(formatContact(fromOnec[1])).toBe('Алматы, ул. Тестовая, 1');
    expect(sortContacts([...fromOnec, ...contacts]).map((contact) => contact.kind)).toEqual(['phone', 'phone', 'phone', 'email', 'address']);
    const own = Array.from({ length: 20 }, (_, index) => ({ contactId: 100 + index, kind: 'email' as const, value: `u${index}@t.kz`,
      valueNormalized: `u${index}@t.kz`, isPrimary: index === 0, note: null }));
    expect('contacts' in draftToInput(contactsToDraft([...own, ...fromOnec]))).toBe(true);
  });
});

describe('copies from 1C of a kind the owner does not keep (a client phone, address)', () => {
  const clientKinds = ['email', 'telegram'] as const;
  const copies = [
    { contactId: 7, kind: 'phone' as const, value: '+7 (701) 555-11-01', valueNormalized: '77015551101', isPrimary: true, note: null, origin: 'onec' as const },
    { contactId: 8, kind: 'address' as const, value: 'Алматы, ул. Тестовая, 1', valueNormalized: 'алматы', isPrimary: false, note: null, origin: 'onec' as const },
    { contactId: 9, kind: 'email' as const, value: 'x@t.kz', valueNormalized: 'x@t.kz', isPrimary: false, note: null, origin: 'onec' as const },
  ];

  it('knows which copy is read-only', () => {
    const rows = contactsToDraft(copies);
    expect(rows.map((row) => isForeignCopy(row, clientKinds))).toEqual([true, true, false]);
    expect(rows.map((row) => isForeignCopy(row, ['phone', 'email', 'telegram', 'address']))).toEqual([false, false, false]);
    expect(isForeignCopy({ fromOnec: false, kind: 'phone' }, clientKinds)).toBe(false);
  });

  it('never sends isPrimary for such a copy, keeps id and value, and lets an email copy be primary', () => {
    let rows = contactsToDraft(copies);
    rows = setDraftPrimary(rows, rows[2].rowKey);
    const body = draftToInput(rows, clientKinds);
    expect(body).toEqual({ contacts: [
      { contactId: 7, kind: 'phone', value: '+7 (701) 555-11-01', isPrimary: false, note: null },
      { contactId: 8, kind: 'address', value: 'Алматы, ул. Тестовая, 1', isPrimary: false, note: null },
      { contactId: 9, kind: 'email', value: 'x@t.kz', isPrimary: true, note: null },
    ] });
    // a supplier keeps phones itself: nothing changes for it
    expect('contacts' in draftToInput(contactsToDraft(copies)) && draftToInput(contactsToDraft(copies)).contacts[0].isPrimary).toBe(true);
  });
});
