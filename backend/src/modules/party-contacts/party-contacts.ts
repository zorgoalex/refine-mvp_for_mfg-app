import type { PermissionName } from '../../permissions/permissions';
import type { ContactErrorCodes } from '../employees/employee-contacts';

/**
 * Kinds of a party contact: the employee kinds, for suppliers addresses (text, from 1C or typed in), for clients
 * messengers (migration 269): WhatsApp and Viber numbers, Instagram accounts and «Другое» with a label in the note.
 */
export const PARTY_CONTACT_KINDS = ['phone', 'email', 'telegram', 'address', 'whatsapp', 'viber', 'instagram', 'other'] as const;
export type PartyContactKind = (typeof PARTY_CONTACT_KINDS)[number];
/** Client kinds behind BACKEND_CLIENT_CONTACT_EXTRA_KINDS (off: stored ones are kept, nothing new or changed is taken). */
export const CLIENT_EXTRA_CONTACT_KINDS = ['whatsapp', 'viber', 'instagram', 'other'] as const satisfies readonly PartyContactKind[];
/** Kinds whose value is a phone number (7XXXXXXXXXX). */
export const PHONE_LIKE_CONTACT_KINDS: readonly PartyContactKind[] = ['phone', 'whatsapp', 'viber'];
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
  /** Kinds of `kinds` that are taken only while BACKEND_CLIENT_CONTACT_EXTRA_KINDS is on. */
  extraKinds: readonly PartyContactKind[];
  /** Contacts of the linked 1C counterparty come in by the sync (suppliers K4a, clients K4b — phones and addresses of a client only from 1C). */
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
    kind: 'supplier', table: 'supplier_contacts', idColumn: 'supplier_id', ownerTable: 'suppliers', kinds: ['phone', 'email', 'telegram', 'address'], extraKinds: [], onec: true,
    view: 'suppliers.view', manage: 'suppliers.manage', auditEvent: 'supplier.contacts.updated',
    notFoundCode: 'SUPPLIER_NOT_FOUND', notFoundText: 'Поставщик не найден', ownerGenitive: 'поставщика',
  },
  vendor: {
    kind: 'vendor', table: 'vendor_contacts', idColumn: 'vendor_id', ownerTable: 'vendors', kinds: ['phone', 'email', 'telegram'], extraKinds: [], onec: false,
    view: 'vendors.view', manage: 'vendors.manage', auditEvent: 'vendor.contacts.updated',
    notFoundCode: 'VENDOR_NOT_FOUND', notFoundText: 'Производитель не найден', ownerGenitive: 'производителя',
  },
  client: {
    kind: 'client', table: 'client_contacts', idColumn: 'client_id', ownerTable: 'clients', kinds: ['email', 'telegram', ...CLIENT_EXTRA_CONTACT_KINDS], extraKinds: CLIENT_EXTRA_CONTACT_KINDS, onec: true,
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
/** The label of a «Другое» contact (its note). */
export const PARTY_NOTE_MAX = 200;

export interface PartyContacts {
  party: PartyKind;
  partyId: number;
  /** Version of the whole set (0 = never saved); for a client — of its emails and messengers (not phones). */
  version: number;
  contacts: PartyContact[];
  /** Kinds a new or changed contact may have now (the editor offers only these). */
  kinds: PartyContactKind[];
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
