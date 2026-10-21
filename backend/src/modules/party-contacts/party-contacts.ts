import type { PermissionName } from '../../permissions/permissions';
import type { ContactErrorCodes, EmployeeContactKind } from '../employees/employee-contacts';

/** Kinds of a party contact: the employee kinds and, for suppliers, addresses (text, from 1C or typed in). */
export const PARTY_CONTACT_KINDS = ['phone', 'email', 'telegram', 'address'] as const;
export type PartyContactKind = EmployeeContactKind | 'address';
/** Where a contact came from: typed in ERP, or brought by the 1C sync (value read-only here). */
export type PartyContactOrigin = 'erp' | 'onec';

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
  kinds: readonly PartyContactKind[];
  /** Contacts of the linked 1C counterparty come in by the sync (suppliers only for now). */
  onec: boolean;
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
    kind: 'supplier', table: 'supplier_contacts', idColumn: 'supplier_id', ownerTable: 'suppliers', kinds: ['phone', 'email', 'telegram', 'address'], onec: true,
    view: 'suppliers.view', manage: 'suppliers.manage', auditEvent: 'supplier.contacts.updated',
    notFoundCode: 'SUPPLIER_NOT_FOUND', notFoundText: 'Поставщик не найден', ownerGenitive: 'поставщика',
  },
  vendor: {
    kind: 'vendor', table: 'vendor_contacts', idColumn: 'vendor_id', ownerTable: 'vendors', kinds: ['phone', 'email', 'telegram'], onec: false,
    view: 'vendors.view', manage: 'vendors.manage', auditEvent: 'vendor.contacts.updated',
    notFoundCode: 'VENDOR_NOT_FOUND', notFoundText: 'Производитель не найден', ownerGenitive: 'производителя',
  },
  client: {
    kind: 'client', table: 'client_contacts', idColumn: 'client_id', ownerTable: 'clients', kinds: ['email', 'telegram'], onec: false,
    view: 'clients.view', manage: 'clients.update', auditEvent: 'client.contacts.updated',
    notFoundCode: 'CLIENT_NOT_FOUND', notFoundText: 'Клиент не найден', ownerGenitive: 'клиента',
  },
};

export const PARTY_CONTACT_CODES: ContactErrorCodes = { invalid: 'PARTY_CONTACT_INVALID', duplicate: 'PARTY_CONTACT_DUPLICATE' };
export const PARTY_CONTACTS_VERSION_CONFLICT = 'PARTY_CONTACTS_VERSION_CONFLICT';
export const PARTY_CONTACT_ONEC_READONLY = 'PARTY_CONTACT_ONEC_READONLY';
/** The user's own contacts per owner (as before); rows from 1C come on top, up to their own cap. */
export const PARTY_OWN_CONTACTS_MAX = 20;
export const PARTY_ONEC_CONTACTS_MAX = 30;
export const PARTY_ADDRESS_MAX = 500;
/** Every other value (as before addresses came). */
export const PARTY_VALUE_MAX = 200;

export interface PartyContacts {
  party: PartyKind;
  partyId: number;
  /** Version of the whole set (0 = never saved); for a client — of emails and Telegram accounts only. */
  version: number;
  contacts: PartyContact[];
}

export interface PartyContact {
  contactId: number;
  kind: PartyContactKind;
  value: string;
  valueNormalized: string;
  isPrimary: boolean;
  note: string | null;
  origin: PartyContactOrigin;
}

/** One line of the set command; a line naming a contact from 1C may only move its «основной» flag and position. */
export interface PartyContactInput {
  contactId: number | null;
  kind: PartyContactKind;
  value: string;
  isPrimary: boolean;
  note: string | null;
}
