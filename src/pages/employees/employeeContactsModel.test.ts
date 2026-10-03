import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import {
  isContactsApiMissing,
  addDraftRow, changeDraftKind, contactsToDraft, draftToInput, formatContact, removeDraftRow, setDraftPrimary, sortContacts,
} from './employeeContactsModel';

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
