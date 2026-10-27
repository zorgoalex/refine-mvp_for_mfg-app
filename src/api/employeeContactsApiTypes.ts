/**
 * Employees keep phones, emails and Telegram accounts; suppliers also keep addresses; clients keep emails and
 * messengers (WhatsApp and Viber numbers, Instagram accounts, «Другое» with a label in the note).
 */
export type EmployeeContactKind = 'phone' | 'email' | 'telegram' | 'address' | 'whatsapp' | 'viber' | 'instagram' | 'other';

export interface EmployeeContact {
  contactId: number;
  kind: EmployeeContactKind;
  value: string;
  /** phone / WhatsApp / Viber 7XXXXXXXXXX, email lower case, Telegram / Instagram account without «@». */
  valueNormalized: string;
  isPrimary: boolean;
  note: string | null;
  /** A contact of a supplier that came from 1C: its value is changed only in 1C (absent — typed in here). */
  origin?: 'erp' | 'onec';
}

export interface EmployeeContacts {
  employeeId: number;
  /** Version of the whole set (also of an empty one): sent back on save. */
  version: number;
  contacts: EmployeeContact[];
}

export interface EmployeeContactInput {
  /** null = a new contact; an existing one keeps its id. */
  contactId: number | null;
  kind: EmployeeContactKind;
  value: string;
  isPrimary: boolean;
  note: string | null;
}

export interface EmployeeContactsReplace {
  version: number;
  contacts: EmployeeContactInput[];
}
