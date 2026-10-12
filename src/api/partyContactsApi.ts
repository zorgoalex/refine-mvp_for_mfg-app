import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type { EmployeeContact, EmployeeContactInput } from './employeeContactsApiTypes';

export type PartyKind = 'supplier' | 'vendor' | 'client';

export interface PartyContacts {
  party: PartyKind;
  partyId: number;
  /** Version of the whole set (0 = never saved); for a client — of emails and Telegram accounts only. */
  version: number;
  contacts: EmployeeContact[];
}

/** A 1C counterparty a supplier can be linked to. */
export interface SupplierCounterparty {
  refKey1c: string;
  name: string;
  /** Marked as a supplier in 1C (null when the source does not say). */
  isSupplier: boolean | null;
  /** The supplier of the directory already linked to it. */
  supplierId: number | null;
  supplierName: string | null;
}

export interface SupplierLink {
  supplierId: number;
  supplierName: string;
  refKey1c: string | null;
  counterpartyName: string | null;
}

/** A 1C counterparty as the loaded 1C data has it. */
export interface CounterpartyCard {
  refKey1c: string;
  name: string;
  code: string | null;
  bin: string | null;
  /** Marked as a buyer in 1C (null when the source does not say). */
  isBuyer: boolean | null;
  phones: string[];
}

export type ClientCounterpartyReason = 'name' | 'phone' | 'similar';

/** A 1C counterparty offered for a client. */
export interface ClientCounterparty extends CounterpartyCard {
  /** Why it is offered: equal name, equal phone, similar name. Empty for a text search. */
  matchedBy: ClientCounterpartyReason[];
  /** The client already linked to it. */
  clientId: number | null;
  clientName: string | null;
}

export interface ClientLink {
  clientId: number;
  clientName: string;
  refKey1c: string | null;
  /** Counterparties of 1C are loaded: without them nothing can be chosen. */
  available: boolean;
  /** null — no link, or the key is not in the loaded 1C data. */
  counterparty: CounterpartyCard | null;
  /** Phones and BIN/IIN are left out: the viewer has no `clients.onec_data.view`. */
  dataHidden?: boolean;
}

export type ClientMatchStrength = 'both' | 'phone' | 'name';

/** A client without a counterparty and the only 1C counterparty that looks like it. */
export interface ClientCounterpartyMatch {
  clientId: number;
  clientName: string;
  clientPhones: string[];
  counterparty: CounterpartyCard;
  strength: ClientMatchStrength;
}

export interface ClientCounterpartyAmbiguity {
  clientId: number;
  clientName: string;
  candidates: Array<{ refKey1c: string; name: string; matchedBy: ClientCounterpartyReason[] }>;
}

export interface ClientCounterpartyMatches {
  available: boolean;
  summary: { clients: number; linked: number; both: number; phone: number; name: number; ambiguous: number; none: number };
  matches: ClientCounterpartyMatch[];
  ambiguous: ClientCounterpartyAmbiguity[];
}

export type ClientConfirmStatus = 'linked' | 'conflict' | 'taken' | 'unknown' | 'not_found' | 'uncertain';

export interface ClientConfirmResult {
  clientId: number;
  refKey1c: string;
  status: ClientConfirmStatus;
  holderClientId: number | null;
  holderClientName: string | null;
}

/** Pairs of one confirmation request (the backend limit). */
export const CLIENT_CONFIRM_MAX = 100;

export const partyContactsApi = {
  get: (party: PartyKind, id: number) => httpClient.get<PartyContacts>(apiRoutes.partyContacts.contacts(party, id)),
  replace: (party: PartyKind, id: number, body: { version: number; contacts: EmployeeContactInput[] }) =>
    httpClient.put<PartyContacts>(apiRoutes.partyContacts.contacts(party, id), body),
  /** Contacts of the owners on a list page. */
  list: (party: 'supplier' | 'vendor', ids: readonly number[]) =>
    httpClient.get<{ items: Array<{ id: number; contacts: EmployeeContact[] }> }>(
      `${apiRoutes.partyContacts.contactsList(party)}?ids=${ids.map((id) => encodeURIComponent(String(id))).join(',')}`),
  supplierCounterparties: (search?: string) =>
    httpClient.get<{ items: SupplierCounterparty[] }>(
      `${apiRoutes.partyContacts.supplierCounterparties}${search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`),
  supplierCounterparty: (supplierId: number) => httpClient.get<SupplierLink>(apiRoutes.partyContacts.supplierCounterparty(supplierId)),
  /** Link, relink or unlink (refKey1c null); `expectedRefKey1c` is the key this page showed. */
  setSupplierCounterparty: (supplierId: number, body: { refKey1c: string | null; expectedRefKey1c: string | null }) =>
    httpClient.put<SupplierLink>(apiRoutes.partyContacts.supplierCounterparty(supplierId), body),
  supplierFromCounterparty: (refKey1c: string) =>
    httpClient.post<SupplierLink & { created: boolean }>(apiRoutes.partyContacts.supplierFromCounterparty, { refKey1c }),
  clientCounterparty: (clientId: number) => httpClient.get<ClientLink>(apiRoutes.partyContacts.clientCounterparty(clientId)),
  /** Without a search text — the counterparties that look like the client (name, phone). */
  clientCounterpartyCandidates: (clientId: number, search?: string) =>
    httpClient.get<{ items: ClientCounterparty[] }>(
      `${apiRoutes.partyContacts.clientCounterpartyCandidates(clientId)}${search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`),
  /** Link, relink or unlink (refKey1c null); `expectedRefKey1c` is the key this page showed. */
  setClientCounterparty: (clientId: number, body: { refKey1c: string | null; expectedRefKey1c: string | null }) =>
    httpClient.put<ClientLink>(apiRoutes.partyContacts.clientCounterparty(clientId), body),
  clientCounterpartyMatches: () => httpClient.get<ClientCounterpartyMatches>(apiRoutes.partyContacts.clientCounterpartyMatches),
  /** At most CLIENT_CONFIRM_MAX pairs; a pair that is no longer possible is reported and skipped. */
  confirmClientCounterparties: (pairs: Array<{ clientId: number; refKey1c: string }>) =>
    httpClient.post<{ results: ClientConfirmResult[] }>(apiRoutes.partyContacts.clientCounterpartyMatchesConfirm, { pairs }),
};
