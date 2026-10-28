import type {
  ClientContactColumn, ClientContactSort, ClientContactsContact, ClientContactsPhone, ClientContactsQuery, ClientContactsRow, ClientPhoneType,
  ColumnFilterValue, ExpectedPhoneLine, PhoneSetLine,
} from '../../api/clientContactsApi';
import { ApiError } from '../../api/apiError';
import { CLIENT_CONTACT_COLUMNS } from '../../api/clientContactsApi';
import type { EmployeeContactInput, EmployeeContactKind } from '../../api/employeeContactsApiTypes';

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_QUERY: ClientContactsQuery = { page: 1, pageSize: 50, sort: 'client', order: 'asc', active: 'active', filters: {} };
const SORTS: readonly ClientContactSort[] = ['client', 'updated', ...CLIENT_CONTACT_COLUMNS];
const PHONE_FORMAT = /^\+?[0-9\s\-()]{7,20}$/;
export const PHONES_MAX = 20;

export const PHONE_TYPE_LABELS: Record<ClientPhoneType, string> = { mobile: 'Мобильный', work: 'Рабочий', home: 'Домашний', fax: 'Факс' };

export const COLUMN_TITLES: Record<ClientContactColumn, string> = {
  phone: 'Телефоны', whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'Email', viber: 'Viber', instagram: 'Instagram', other: 'Другое',
};

/** The query of the page from its URL (anything unknown falls back to the default). */
export function readQuery(params: URLSearchParams): ClientContactsQuery {
  const number = (key: string, fallback: number, allowed?: readonly number[]) => {
    const value = Number(params.get(key));
    if (!Number.isSafeInteger(value) || value < 1) return fallback;
    return allowed && !allowed.includes(value) ? fallback : value;
  };
  const sort = params.get('sort') as ClientContactSort | null;
  const active = params.get('active');
  const filters: ClientContactsQuery['filters'] = {};
  for (const column of CLIENT_CONTACT_COLUMNS) {
    const value = params.get(`f.${column}`);
    if (value === 'has' || value === 'none' || (value?.startsWith('~') && value.length > 1)) filters[column] = value as ColumnFilterValue;
  }
  return {
    q: params.get('q')?.slice(0, 100) || undefined,
    page: number('page', 1),
    pageSize: number('pageSize', DEFAULT_QUERY.pageSize, PAGE_SIZES),
    sort: sort && SORTS.includes(sort) ? sort : DEFAULT_QUERY.sort,
    order: params.get('order') === 'desc' ? 'desc' : 'asc',
    active: active === 'archived' || active === 'all' ? active : 'active',
    filters,
  };
}

/** The URL form of a query: only what differs from the default. */
export function writeQuery(query: ClientContactsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_QUERY.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.sort !== DEFAULT_QUERY.sort) params.set('sort', query.sort);
  if (query.order !== DEFAULT_QUERY.order) params.set('order', query.order);
  if (query.active !== DEFAULT_QUERY.active) params.set('active', query.active);
  for (const column of CLIENT_CONTACT_COLUMNS) {
    const filter = query.filters[column];
    if (filter) params.set(`f.${column}`, filter);
  }
  return params;
}

export const hasFilters = (query: ClientContactsQuery) => Boolean(query.q?.trim()) || Object.keys(query.filters).length > 0 || query.active !== 'active';

/** A read-only copy from the linked 1C counterparty: shown in its column, never edited here. */
export const isOnecCopy = (contact: Pick<ClientContactsContact, 'origin'>): boolean => contact.origin === 'onec';

/** Values of one column of a row, the primary first; the phone column ends with the phone copies from 1C. */
export function columnValues(row: ClientContactsRow, column: ClientContactColumn): Array<ClientContactsPhone | ClientContactsContact> {
  if (column === 'phone') return [...row.phones, ...row.contacts.filter((contact) => contact.kind === 'phone' && isOnecCopy(contact))];
  return row.contacts.filter((contact) => contact.kind === column);
}

// ---- phones editor -------------------------------------------------------------------------------------------------

export interface PhoneDraft {
  rowKey: string;
  phoneId: number | null;
  phoneNumber: string;
  phoneType: ClientPhoneType;
  isPrimary: boolean;
}

let nextKey = 0;
const key = () => `draft-${++nextKey}`;

export const phonesToDraft = (phones: readonly ClientContactsPhone[]): PhoneDraft[] =>
    // A stored NULL type / primary becomes «mobile» / not primary in the draft; saving writes that value.
  phones.map((phone) => ({ rowKey: key(), phoneId: phone.phoneId, phoneNumber: phone.phoneNumber, phoneType: phone.phoneType ?? 'mobile',
    isPrimary: phone.isPrimary ?? false }));

/** The set the screen saw, as stored (nulls included) — the server compares it with the locked rows. */
export const phoneLines = (phones: readonly ClientContactsPhone[]): ExpectedPhoneLine[] =>
  phones.map(({ phoneId, phoneNumber, phoneType, isPrimary }) => ({ phoneId, phoneNumber, phoneType, isPrimary }));

export function addPhoneDraft(rows: readonly PhoneDraft[]): PhoneDraft[] {
  return [...rows, { rowKey: key(), phoneId: null, phoneNumber: '', phoneType: 'mobile', isPrimary: rows.length === 0 }];
}

export function setPhonePrimary(rows: readonly PhoneDraft[], rowKey: string): PhoneDraft[] {
  return rows.map((row) => ({ ...row, isPrimary: row.rowKey === rowKey }));
}

export function removePhoneDraft(rows: readonly PhoneDraft[], rowKey: string): PhoneDraft[] {
  const removed = rows.find((row) => row.rowKey === rowKey);
  const rest = rows.filter((row) => row.rowKey !== rowKey);
  return removed?.isPrimary && rest[0] ? setPhonePrimary(rest, rest[0].rowKey) : rest;
}

/** The phones command body or a local error (the backend checks the same and more). */
export function phoneDraftToLines(rows: readonly PhoneDraft[]): { phones: PhoneSetLine[] } | { error: string } {
  if (rows.length > PHONES_MAX) return { error: `Не больше ${PHONES_MAX} телефонов у клиента` };
  const digits = new Set<string>();
  for (const row of rows) {
    const number = row.phoneNumber.trim();
    if (!PHONE_FORMAT.test(number)) return { error: number ? `Телефон «${number}» указан неверно` : 'Заполните номер или удалите пустую строку' };
    const only = number.replace(/\D/g, '');
    if (digits.has(only)) return { error: `Телефон «${number}» указан дважды` };
    digits.add(only);
  }
  return { phones: rows.map((row) => ({ phoneId: row.phoneId, phoneNumber: row.phoneNumber.trim(), phoneType: row.phoneType, isPrimary: row.isPrimary })) };
}

/**
 * After a conflict the draft stays for a new attempt against the fresh set: a phone that is no longer there becomes
 * a new one, a phone still there keeps its id.
 */
export function rebasePhoneDraft(rows: readonly PhoneDraft[], fresh: readonly ClientContactsPhone[]): PhoneDraft[] {
  const ids = new Set(fresh.map((phone) => phone.phoneId));
  return rows.map((row) => (row.phoneId !== null && !ids.has(row.phoneId) ? { ...row, phoneId: null } : row));
}

// ---- contacts editor (one kind of a client) ------------------------------------------------------------------------

export interface KindDraft {
  rowKey: string;
  contactId: number | null;
  value: string;
  note: string;
  isPrimary: boolean;
}

export const kindToDraft = (row: ClientContactsRow, kind: EmployeeContactKind): KindDraft[] =>
  row.contacts.filter((contact) => contact.kind === kind && !isOnecCopy(contact))
    .map((contact) => ({ rowKey: key(), contactId: contact.contactId, value: contact.value, note: contact.note ?? '', isPrimary: contact.isPrimary }));

export function addKindDraft(rows: readonly KindDraft[]): KindDraft[] {
  return [...rows, { rowKey: key(), contactId: null, value: '', note: '', isPrimary: rows.length === 0 }];
}

export function setKindPrimary(rows: readonly KindDraft[], rowKey: string): KindDraft[] {
  return rows.map((row) => ({ ...row, isPrimary: row.rowKey === rowKey }));
}

export function removeKindDraft(rows: readonly KindDraft[], rowKey: string): KindDraft[] {
  const removed = rows.find((row) => row.rowKey === rowKey);
  const rest = rows.filter((row) => row.rowKey !== rowKey);
  return removed?.isPrimary && rest[0] ? setKindPrimary(rest, rest[0].rowKey) : rest;
}

/**
 * The whole set command of the client: every contact of the other kinds goes back as it is (the set replaces all of
 * them), the edited kind comes from the draft.
 */
export function kindDraftToSet(row: ClientContactsRow, kind: EmployeeContactKind, rows: readonly KindDraft[]):
  { contacts: EmployeeContactInput[] } | { error: string } {
  if (rows.some((draft) => !draft.value.trim())) return { error: 'Заполните значение или удалите пустую строку' };
  if (kind === 'other' && rows.some((draft) => !draft.note.trim())) return { error: 'У контакта «Другое» укажите подпись (например, VK)' };
  // The copies from 1C are not sent: the server keeps the ones a set does not name.
  const others = row.contacts.filter((contact) => contact.kind !== kind && !isOnecCopy(contact))
    .map((contact) => ({ contactId: contact.contactId, kind: contact.kind, value: contact.value, isPrimary: contact.isPrimary, note: contact.note }));
  const edited = rows.map((draft) => ({
    contactId: draft.contactId, kind, value: draft.value.trim(), isPrimary: draft.isPrimary, note: draft.note.trim() ? draft.note.trim() : null,
  }));
  return { contacts: [...others, ...edited] };
}

export function rebaseKindDraft(rows: readonly KindDraft[], fresh: ClientContactsRow, kind: EmployeeContactKind): KindDraft[] {
  const ids = new Set(fresh.contacts.filter((contact) => contact.kind === kind && !isOnecCopy(contact)).map((contact) => contact.contactId));
  return rows.map((row) => (row.contactId !== null && !ids.has(row.contactId) ? { ...row, contactId: null } : row));
}

/** An older backend has no such route (404): the screen says so instead of an empty list. */
export function listError(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 404) return 'Экран ещё недоступен: backend не обновлён';
  return caught instanceof Error ? caught.message : 'Не удалось загрузить контакты';
}

/** Requests of a list answer in any order: only the latest one may apply its answer. */
export function requestGate() {
  let latest = 0;
  return { start: () => ++latest, isLatest: (token: number) => token === latest };
}

/** The idempotency key of a phones save: the same body keeps its key (a retry after a lost answer), another body gets a new one. */
export function keyFor(previous: { signature: string; key: string } | null, signature: string, fresh: () => string): { signature: string; key: string } {
  return previous && previous.signature === signature ? previous : { signature, key: fresh() };
}
