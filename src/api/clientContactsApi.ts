import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type { EmployeeContactInput, EmployeeContactKind } from './employeeContactsApiTypes';

export type ClientPhoneType = 'mobile' | 'work' | 'home' | 'fax';

/** Columns of «Контакты клиентов»: client phones and the kinds of client contacts. */
export const CLIENT_CONTACT_COLUMNS = ['phone', 'whatsapp', 'telegram', 'email', 'viber', 'instagram', 'other'] as const;
export type ClientContactColumn = (typeof CLIENT_CONTACT_COLUMNS)[number];
export type ClientContactSort = 'client' | 'updated' | ClientContactColumn;

export interface ClientContactsPhone {
  phoneId: number;
  phoneNumber: string;
  /** As stored: may be null in old rows. */
  phoneType: ClientPhoneType | null;
  isPrimary: boolean | null;
}

/** A phone of the set the screen saw, sent back as it is (nulls included). */
export type ExpectedPhoneLine = Pick<ClientContactsPhone, 'phoneId' | 'phoneNumber' | 'phoneType' | 'isPrimary'>;

export interface ClientContactsContact {
  contactId: number;
  kind: EmployeeContactKind;
  value: string;
  valueNormalized: string;
  isPrimary: boolean;
  note: string | null;
  /** `onec` — a read-only copy from the linked 1C counterparty (only for readers with `clients.onec_data.view`). */
  origin?: 'erp' | 'onec';
}

export interface ClientContactsRow {
  client: { id: number; name: string; isActive: boolean; personType: string | null };
  phones: ClientContactsPhone[];
  contacts: ClientContactsContact[];
  /** Version of the client's emails and messengers: sent back on save. */
  contactsVersion: number;
  updatedAt: string | null;
}

export interface ClientContactsPage {
  items: ClientContactsRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Kinds a new or changed contact may have now. */
  kinds: EmployeeContactKind[];
  canManage: boolean;
  /** The client phones commands are on (BACKEND_ENABLE_CLIENT_PHONES). */
  phonesEditable: boolean;
}

/** A column filter: `has`, `none`, or `~text` (contains). */
export type ColumnFilterValue = 'has' | 'none' | `~${string}`;

export interface ClientContactsQuery {
  q?: string;
  page: number;
  pageSize: number;
  sort: ClientContactSort;
  order: 'asc' | 'desc';
  active: 'active' | 'archived' | 'all';
  filters: Partial<Record<ClientContactColumn, ColumnFilterValue>>;
}

export interface PhoneSetLine {
  phoneId: number | null;
  phoneNumber: string;
  phoneType: ClientPhoneType;
  isPrimary: boolean;
}

export function clientContactsSearch(query: ClientContactsQuery): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('sort', query.sort);
  params.set('order', query.order);
  params.set('active', query.active);
  for (const column of CLIENT_CONTACT_COLUMNS) {
    const filter = query.filters[column];
    if (filter && filter !== '~') params.set(`f.${column}`, filter);
  }
  return params.toString();
}

export const clientContactsApi = {
  list: (query: ClientContactsQuery) => httpClient.get<ClientContactsPage>(`${apiRoutes.clientContacts.list}?${clientContactsSearch(query)}`),
  row: (clientId: number) => httpClient.get<ClientContactsRow>(apiRoutes.clientContacts.row(clientId)),
  /** Emails and messengers of the client (the whole set, with the version the screen saw). */
  replaceContacts: (clientId: number, body: { version: number; contacts: EmployeeContactInput[] }) =>
    httpClient.put<ClientContactsRow>(apiRoutes.clientContacts.contacts(clientId), body),
  /** Phones of the client: `expected` is the set the screen saw; a new key per attempt after a conflict. */
  replacePhones: (clientId: number, body: { idempotencyKey: string; expected: ExpectedPhoneLine[]; phones: PhoneSetLine[] }) =>
    httpClient.put<{ result: { created: number; updated: number; deleted: number }; row: ClientContactsRow }>(apiRoutes.clientContacts.phones(clientId), body),
};
