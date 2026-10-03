export type EmployeeContactKind = 'phone' | 'email' | 'telegram';

export interface EmployeeContact {
  contactId: number;
  kind: EmployeeContactKind;
  value: string;
  /** phone 7XXXXXXXXXX, email lower case, Telegram username without «@». */
  valueNormalized: string;
  isPrimary: boolean;
  note: string | null;
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
