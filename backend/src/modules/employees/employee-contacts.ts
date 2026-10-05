import { ApiError } from '../../common/errors/api-error';
import { maskPhone, normalizeClientPhone } from '../whatsapp/order-send/order-send-phone';

export const EMPLOYEE_CONTACT_KINDS = ['phone', 'email', 'telegram'] as const;
export type EmployeeContactKind = (typeof EMPLOYEE_CONTACT_KINDS)[number];
export const EMPLOYEE_CONTACTS_MAX = 20;
export const EMPLOYEES_VIEW = 'employees.view' as const;
export const EMPLOYEES_MANAGE = 'employees.manage' as const;

export interface EmployeeContact {
  contactId: number;
  kind: EmployeeContactKind;
  value: string;
  valueNormalized: string;
  isPrimary: boolean;
  note: string | null;
}

export interface EmployeeContacts {
  employeeId: number;
  version: number;
  contacts: EmployeeContact[];
}

/** One line of the replace command: an existing contact keeps its id (sends that used it stay valid). */
export interface EmployeeContactInput {
  contactId: number | null;
  kind: EmployeeContactKind;
  value: string;
  isPrimary: boolean;
  note: string | null;
}

/** Error codes of the contact rules: employees keep theirs, other owners (suppliers, vendors, clients) pass their own. */
export interface ContactErrorCodes { invalid: string; duplicate: string }
export const EMPLOYEE_CONTACT_CODES: ContactErrorCodes = { invalid: 'EMPLOYEE_CONTACT_INVALID', duplicate: 'EMPLOYEE_CONTACT_DUPLICATE' };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TELEGRAM = /^@?([A-Za-z0-9_]{5,32})$/;

/** The comparable form of a contact (unique per employee and kind): phone 7XXXXXXXXXX, email lower case, telegram without «@». */
export function normalizeContact(kind: EmployeeContactKind, raw: string, codes: ContactErrorCodes = EMPLOYEE_CONTACT_CODES): string {
  const value = raw.trim();
  if (kind === 'phone') {
    try {
      return normalizeClientPhone(value);
    } catch {
      throw new ApiError(422, codes.invalid, `Телефон «${value}» не удалось распознать`, { kind });
    }
  }
  if (kind === 'email') {
    if (!EMAIL.test(value)) throw new ApiError(422, codes.invalid, `Email «${value}» указан неверно`, { kind });
    return value.toLowerCase();
  }
  const match = TELEGRAM.exec(value.replace(/^https?:\/\/t\.me\//i, ''));
  if (!match) throw new ApiError(422, codes.invalid, `Аккаунт Telegram «${value}» указан неверно (5–32 символа: латиница, цифры, «_»)`, { kind });
  return match[1].toLowerCase();
}

/** The only form a contact value takes in audit and logs. */
export function maskContact(kind: EmployeeContactKind, normalized: string): string {
  if (kind === 'phone') return maskPhone(normalized);
  if (kind === 'email') {
    const [name, domain] = normalized.split('@');
    return `${name.slice(0, 2)}***@${domain ?? ''}`;
  }
  return `@${normalized.slice(0, 2)}***`;
}

/**
 * Validates and normalizes a whole set: at most 20 contacts, no duplicate value per kind, at most one
 * primary per kind; the first contact of a kind without a primary becomes primary.
 */
export function prepareContacts(input: readonly EmployeeContactInput[], codes: ContactErrorCodes = EMPLOYEE_CONTACT_CODES,
  owner = 'сотрудника'): Array<EmployeeContactInput & { valueNormalized: string; position: number }> {
  if (input.length > EMPLOYEE_CONTACTS_MAX) {
    throw new ApiError(422, codes.invalid, `Не больше ${EMPLOYEE_CONTACTS_MAX} контактов у ${owner}`);
  }
  const prepared = input.map((contact, position) => ({
    ...contact, value: contact.value.trim(), note: contact.note?.trim() ? contact.note.trim() : null,
    valueNormalized: normalizeContact(contact.kind, contact.value, codes), position,
  }));
  const ids = new Set<number>();
  for (const contact of input) {
    if (contact.contactId === null) continue;
    if (ids.has(contact.contactId)) throw new ApiError(422, codes.invalid, 'Один контакт указан в наборе дважды');
    ids.add(contact.contactId);
  }
  const seen = new Set<string>();
  for (const contact of prepared) {
    const key = `${contact.kind}:${contact.valueNormalized}`;
    if (seen.has(key)) throw new ApiError(422, codes.duplicate, `Контакт «${contact.value}» указан дважды`);
    seen.add(key);
  }
  for (const kind of EMPLOYEE_CONTACT_KINDS) {
    const ofKind = prepared.filter((contact) => contact.kind === kind);
    const primaries = ofKind.filter((contact) => contact.isPrimary);
    if (primaries.length > 1) throw new ApiError(422, codes.invalid, 'Основным может быть только один контакт каждого типа');
    if (ofKind.length && !primaries.length) ofKind[0].isPrimary = true;
  }
  return prepared;
}
