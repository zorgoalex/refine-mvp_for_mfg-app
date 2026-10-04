import type { PermissionName } from '../../permissions/permissions';
import type { ContactErrorCodes, EmployeeContactKind } from '../employees/employee-contacts';

/** Owners of a contact set kept by this module (employees keep their own module and routes). */
export const PARTY_KINDS = ['supplier', 'vendor', 'client'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export interface PartyConfig {
  kind: PartyKind;
  /** Contacts table and its owner key column. */
  table: string;
  idColumn: string;
  /** Owner table (locked FOR NO KEY UPDATE by the command; never updated by it). */
  ownerTable: string;
  /** Kinds this owner keeps here: a client's phones live in client_phones. */
  kinds: readonly EmployeeContactKind[];
  view: PermissionName;
  manage: PermissionName;
  auditEvent: string;
  notFoundCode: string;
  notFoundText: string;
  /** Genitive, for messages: «контактов у поставщика». */
  ownerGenitive: string;
}

export const PARTY_CONFIG: Record<PartyKind, PartyConfig> = {
  supplier: {
    kind: 'supplier', table: 'supplier_contacts', idColumn: 'supplier_id', ownerTable: 'suppliers', kinds: ['phone', 'email', 'telegram'],
    view: 'suppliers.view', manage: 'suppliers.manage', auditEvent: 'supplier.contacts.updated',
    notFoundCode: 'SUPPLIER_NOT_FOUND', notFoundText: 'Поставщик не найден', ownerGenitive: 'поставщика',
  },
  vendor: {
    kind: 'vendor', table: 'vendor_contacts', idColumn: 'vendor_id', ownerTable: 'vendors', kinds: ['phone', 'email', 'telegram'],
    view: 'vendors.view', manage: 'vendors.manage', auditEvent: 'vendor.contacts.updated',
    notFoundCode: 'VENDOR_NOT_FOUND', notFoundText: 'Производитель не найден', ownerGenitive: 'производителя',
  },
  client: {
    kind: 'client', table: 'client_contacts', idColumn: 'client_id', ownerTable: 'clients', kinds: ['email', 'telegram'],
    view: 'clients.view', manage: 'clients.update', auditEvent: 'client.contacts.updated',
    notFoundCode: 'CLIENT_NOT_FOUND', notFoundText: 'Клиент не найден', ownerGenitive: 'клиента',
  },
};

export const PARTY_CONTACT_CODES: ContactErrorCodes = { invalid: 'PARTY_CONTACT_INVALID', duplicate: 'PARTY_CONTACT_DUPLICATE' };
export const PARTY_CONTACTS_VERSION_CONFLICT = 'PARTY_CONTACTS_VERSION_CONFLICT';

export interface PartyContacts {
  party: PartyKind;
  partyId: number;
  /** Version of the whole set (0 = never saved); for a client — of emails and Telegram accounts only. */
  version: number;
  contacts: Array<{ contactId: number; kind: EmployeeContactKind; value: string; valueNormalized: string; isPrimary: boolean; note: string | null }>;
}
