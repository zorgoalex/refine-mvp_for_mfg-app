import { ApiError } from '../../api/apiError';
import type { EmployeeContact, EmployeeContactInput, EmployeeContactKind } from '../../api/employeeContactsApiTypes';

export const EMPLOYEE_CONTACT_KIND_LABELS: Record<EmployeeContactKind, string> = {
  phone: 'Телефон',
  email: 'Email',
  telegram: 'Telegram',
};
export const EMPLOYEE_CONTACT_KINDS: EmployeeContactKind[] = ['phone', 'email', 'telegram'];
export const EMPLOYEE_CONTACTS_MAX = 20;

/** A row of the editor; `rowKey` is local only (new rows have no contactId yet). */
export interface EmployeeContactDraft {
  rowKey: string;
  contactId: number | null;
  kind: EmployeeContactKind;
  value: string;
  isPrimary: boolean;
  note: string;
}

/**
 * A backend of the previous release has no contacts API: its 404 is not «employee not found». Then the
 * contacts column and card are hidden instead of showing an error (mixed deploy, rollback).
 */
export function isContactsApiMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code !== 'EMPLOYEE_NOT_FOUND';
}

let nextRow = 0;
const rowKey = () => `row-${++nextRow}`;

export function contactsToDraft(contacts: readonly EmployeeContact[]): EmployeeContactDraft[] {
  return contacts.map((contact) => ({
    rowKey: rowKey(), contactId: contact.contactId, kind: contact.kind, value: contact.value,
    isPrimary: contact.isPrimary, note: contact.note ?? '',
  }));
}

/** A new row; the first contact of its kind becomes primary. */
export function addDraftRow(rows: readonly EmployeeContactDraft[], kind: EmployeeContactKind): EmployeeContactDraft[] {
  return [...rows, { rowKey: rowKey(), contactId: null, kind, value: '', isPrimary: !rows.some((row) => row.kind === kind), note: '' }];
}

/** Marks one row primary; the others of the same kind lose the flag. */
export function setDraftPrimary(rows: readonly EmployeeContactDraft[], key: string): EmployeeContactDraft[] {
  const target = rows.find((row) => row.rowKey === key);
  if (!target) return [...rows];
  return rows.map((row) => (row.kind === target.kind ? { ...row, isPrimary: row.rowKey === key } : row));
}

/** Removes a row; if it was primary, the next one of its kind takes over. */
export function removeDraftRow(rows: readonly EmployeeContactDraft[], key: string): EmployeeContactDraft[] {
  const removed = rows.find((row) => row.rowKey === key);
  const rest = rows.filter((row) => row.rowKey !== key);
  if (!removed?.isPrimary) return rest;
  const heir = rest.find((row) => row.kind === removed.kind);
  return heir ? setDraftPrimary(rest, heir.rowKey) : rest;
}

/** Changing a row's kind keeps one primary per kind on both sides. */
export function changeDraftKind(rows: readonly EmployeeContactDraft[], key: string, kind: EmployeeContactKind): EmployeeContactDraft[] {
  const row = rows.find((item) => item.rowKey === key);
  if (!row || row.kind === kind) return [...rows];
  const without = removeDraftRow(rows, key);
  const moved = { ...row, kind, isPrimary: !without.some((item) => item.kind === kind) };
  const index = rows.findIndex((item) => item.rowKey === key);
  return [...without.slice(0, index), moved, ...without.slice(index)];
}

/** The command body; an empty value is a local error (the backend validates the rest). */
export function draftToInput(rows: readonly EmployeeContactDraft[]): { contacts: EmployeeContactInput[] } | { error: string } {
  if (rows.length > EMPLOYEE_CONTACTS_MAX) return { error: `Не больше ${EMPLOYEE_CONTACTS_MAX} контактов` };
  if (rows.some((row) => !row.value.trim())) return { error: 'Заполните значение каждого контакта или удалите пустую строку' };
  return {
    contacts: rows.map((row) => ({
      contactId: row.contactId, kind: row.kind, value: row.value.trim(), isPrimary: row.isPrimary,
      note: row.note.trim() ? row.note.trim() : null,
    })),
  };
}

/** Display form of a contact: phone +7 XXX XXX XX XX, Telegram with «@». */
export function formatContact(contact: Pick<EmployeeContact, 'kind' | 'valueNormalized'>): string {
  const value = contact.valueNormalized;
  if (contact.kind === 'phone' && /^7\d{10}$/.test(value)) {
    return `+7 ${value.slice(1, 4)} ${value.slice(4, 7)} ${value.slice(7, 9)} ${value.slice(9)}`;
  }
  if (contact.kind === 'telegram') return `@${value}`;
  return value;
}

/** Contacts in display order: by kind, the primary first. */
export function sortContacts(contacts: readonly EmployeeContact[]): EmployeeContact[] {
  return [...contacts].sort((a, b) => EMPLOYEE_CONTACT_KINDS.indexOf(a.kind) - EMPLOYEE_CONTACT_KINDS.indexOf(b.kind)
    || Number(b.isPrimary) - Number(a.isPrimary));
}
