import { ApiError } from '../../common/errors/api-error';
import { maskContact, normalizeContact } from '../employees/employee-contacts';
import { maskPhone, normalizeClientPhone } from '../whatsapp/order-send/order-send-phone';
import {
  PARTY_ADDRESS_MAX, PARTY_CONTACT_CODES, PARTY_VALUE_MAX, PARTY_CONTACT_KINDS, PARTY_CONTACT_ONEC_READONLY, PARTY_CONTACTS_VERSION_CONFLICT, PARTY_OWN_CONTACTS_MAX,
  type PartyContactInput, type PartyContactKind, type PartyContactOrigin,
} from './party-contacts';

const INSTAGRAM = /^@?([a-z0-9._]{1,30})\/?$/;
const KIND_TEXT: Partial<Record<PartyContactKind, string>> = { whatsapp: 'WhatsApp', viber: 'Viber' };

/** An address compares by its words: spaces collapsed, lower case. */
export function normalizeAddress(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The comparable form of a party contact (unique per owner and kind). */
export function normalizePartyContact(kind: PartyContactKind, raw: string): string {
  if (kind !== 'address') {
    if (raw.trim().length > PARTY_VALUE_MAX) throw new ApiError(422, PARTY_CONTACT_CODES.invalid, `Значение — не длиннее ${PARTY_VALUE_MAX} символов`, { kind });
    if (kind === 'phone' || kind === 'email' || kind === 'telegram') return normalizeContact(kind, raw, PARTY_CONTACT_CODES);
    return normalizeMessenger(kind, raw.trim());
  }
  const value = normalizeAddress(raw);
  if (!value || raw.trim().length > PARTY_ADDRESS_MAX) {
    throw new ApiError(422, PARTY_CONTACT_CODES.invalid, `Адрес — от 1 до ${PARTY_ADDRESS_MAX} символов`, { kind });
  }
  return value;
}

/** The only form of a value in audit and logs; an address — by its length. */
export function maskPartyContact(kind: PartyContactKind, normalized: string): string {
  if (kind === 'address') return `адрес (${normalized.length})`;
  if (kind === 'other') return `другое (${normalized.length})`;
  if (kind === 'whatsapp' || kind === 'viber') return maskPhone(normalized);
  if (kind === 'instagram') return `@${normalized.slice(0, 2)}***`;
  return maskContact(kind, normalized);
}

/** WhatsApp / Viber — a number like a client phone (7XXXXXXXXXX); Instagram — the account without «@» or the link; «Другое» — by its words. */
function normalizeMessenger(kind: 'whatsapp' | 'viber' | 'instagram' | 'other', value: string): string {
  if (kind === 'whatsapp' || kind === 'viber') {
    try {
      return normalizeClientPhone(value);
    } catch {
      throw new ApiError(422, PARTY_CONTACT_CODES.invalid, `Номер ${KIND_TEXT[kind]} не удалось распознать (нужен номер +7 XXX XXX XX XX)`, { kind });
    }
  }
  if (kind === 'instagram') {
    const match = INSTAGRAM.exec(value.replace(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i, '').toLowerCase());
    if (!match) throw new ApiError(422, PARTY_CONTACT_CODES.invalid, 'Аккаунт Instagram указан неверно (до 30 символов: латиница, цифры, «.», «_»)', { kind });
    return match[1];
  }
  const words = value.replace(/\s+/g, ' ').toLowerCase();
  if (!words) throw new ApiError(422, PARTY_CONTACT_CODES.invalid, 'Значение не может быть пустым', { kind });
  return words;
}

/** A contact as stored (what the set command starts from). `available` — a row from 1C whose 1C data may be shown now. */
export interface StoredContact {
  contactId: number;
  kind: PartyContactKind;
  /** As stored and shown (for a row of 1C — its presentation in 1C, which need not read as the value). */
  value: string;
  valueNormalized: string;
  isPrimary: boolean;
  position: number;
  origin: PartyContactOrigin;
  available: boolean;
  /** The label («Другое»); compared when a switched-off kind comes back unchanged. */
  note?: string | null;
}

/** A line naming a row of 1C must bring its value back unchanged: as shown, or the same value in another spelling. */
function sameOnecValue(line: PartyContactInput, row: StoredContact): boolean {
  if (line.kind !== row.kind) return false;
  if (line.value.trim() === row.value.trim()) return true;
  try {
    return normalizePartyContact(line.kind, line.value) === row.valueNormalized;
  } catch {
    return false;
  }
}

export interface PlannedOwn { contactId: number | null; kind: PartyContactKind; value: string; valueNormalized: string; isPrimary: boolean; note: string | null; position: number }
export interface PlannedOnec { contactId: number; isPrimary: boolean; position: number }

/**
 * The set command against what is stored. The user's own contacts are replaced by the lines of the command as
 * before; a contact from 1C is never removed or changed by it — a line naming it may only move «основной» and its
 * position, an unnamed one keeps its place. One «основной» per kind over the whole visible set (own and 1C); a kind
 * without one gets its first line. A row of 1C that may not be shown now (the 1C data is revoked or expired) takes
 * no part: it is not named, and the command takes «основной» off it (it is no longer the one the user sees).
 */
export function planContactSet(
  input: readonly PartyContactInput[], stored: readonly StoredContact[], kinds: readonly PartyContactKind[], owner: string,
  frozen: readonly PartyContactKind[] = [],
): { own: PlannedOwn[]; onec: PlannedOnec[] } {
  const byId = new Map(stored.map((row) => [row.contactId, row]));
  const named = new Set<number>();
  for (const line of input) {
    if (!PARTY_CONTACT_KINDS.includes(line.kind) || !kinds.includes(line.kind)) {
      throw new ApiError(422, PARTY_CONTACT_CODES.invalid, owner === 'клиента'
        ? 'Телефоны клиента ведутся в списке телефонов клиента' : 'Этот вид контакта здесь не ведётся', { kind: line.kind });
    }
    if (line.contactId === null) continue;
    if (named.has(line.contactId)) throw new ApiError(422, PARTY_CONTACT_CODES.invalid, 'Один контакт указан в наборе дважды');
    named.add(line.contactId);
    const row = byId.get(line.contactId);
    // A hidden row of 1C is not offered to the user: naming it is a stale form, like a removed contact.
    if (!row || (row.origin === 'onec' && !row.available)) {
      throw new ApiError(409, PARTY_CONTACTS_VERSION_CONFLICT, 'Контакт уже удалён; обновите страницу');
    }
  }

  const own: PlannedOwn[] = [];
  const onec = new Map<number, PlannedOnec & { kind: PartyContactKind; valueNormalized: string; explicit: boolean }>();
  input.forEach((line, position) => {
    const row = line.contactId === null ? undefined : byId.get(line.contactId);
    if (row?.origin === 'onec') {
      if (!sameOnecValue(line, row)) {
        throw new ApiError(422, PARTY_CONTACT_ONEC_READONLY, 'Контакт из 1С меняется только в 1С', { contactId: row.contactId });
      }
      onec.set(row.contactId, { contactId: row.contactId, kind: row.kind, valueNormalized: row.valueNormalized, isPrimary: line.isPrimary, position, explicit: true });
      return;
    }
    const planned: PlannedOwn = {
      contactId: line.contactId, kind: line.kind, value: line.value.trim(), valueNormalized: normalizePartyContact(line.kind, line.value),
      isPrimary: line.isPrimary, note: line.note?.trim() ? line.note.trim() : null, position,
    };
    if (planned.kind === 'other' && !planned.note) {
      throw new ApiError(422, PARTY_CONTACT_CODES.invalid, 'У контакта «Другое» укажите подпись (например, VK)', { kind: planned.kind });
    }
    // A kind switched off now: a stored contact comes back as it is (the set stays savable), nothing new or changed.
    if (frozen.includes(planned.kind) && !(row && row.kind === planned.kind && row.valueNormalized === planned.valueNormalized
      && (row.note ?? null) === planned.note)) {
      throw new ApiError(422, PARTY_CONTACT_CODES.invalid, 'Этот вид контакта сейчас не ведётся: его можно только оставить как есть или удалить',
        { kind: planned.kind });
    }
    own.push(planned);
  });
  if (own.length > PARTY_OWN_CONTACTS_MAX) {
    throw new ApiError(422, PARTY_CONTACT_CODES.invalid, `Не больше ${PARTY_OWN_CONTACTS_MAX} своих контактов у ${owner}`);
  }
  for (const row of stored) {
    if (row.origin === 'onec' && row.available && !onec.has(row.contactId)) {
      onec.set(row.contactId, { contactId: row.contactId, kind: row.kind, valueNormalized: row.valueNormalized, isPrimary: row.isPrimary, position: row.position, explicit: false });
    }
  }

  const seen = new Map<string, PartyContactOrigin>();
  for (const row of onec.values()) seen.set(`${row.kind}:${row.valueNormalized}`, 'onec');
  for (const line of own) {
    const key = `${line.kind}:${line.valueNormalized}`;
    const taken = seen.get(key);
    if (taken) {
      // The line, not the value: error payloads are not masked.
      const where = `в строке ${line.position + 1}`;
      throw new ApiError(422, PARTY_CONTACT_CODES.duplicate, taken === 'onec' ? `Контакт ${where} уже есть из 1С` : `Контакт ${where} указан дважды`,
        { kind: line.kind, line: line.position + 1 });
    }
    seen.set(key, 'erp');
  }

  for (const kind of kinds) {
    const explicit = [...own.filter((line) => line.kind === kind && line.isPrimary),
      ...[...onec.values()].filter((row) => row.kind === kind && row.explicit && row.isPrimary)];
    if (explicit.length > 1) throw new ApiError(422, PARTY_CONTACT_CODES.invalid, 'Основным может быть только один контакт каждого типа');
    // A named line decides; otherwise an unnamed row of 1C may keep the flag it had.
    const kept = explicit.length ? [] : [...onec.values()].filter((row) => row.kind === kind && !row.explicit && row.isPrimary).slice(0, 1);
    const winner = explicit[0] ?? kept[0];
    for (const row of onec.values()) if (row.kind === kind) row.isPrimary = row === winner;
    for (const line of own) if (line.kind === kind) line.isPrimary = line === winner;
    if (!winner) {
      const first = [...own.filter((line) => line.kind === kind), ...[...onec.values()].filter((row) => row.kind === kind)]
        .sort((left, right) => left.position - right.position)[0];
      if (first) first.isPrimary = true;
    }
  }
  return { own, onec: [...onec.values()].map(({ contactId, isPrimary, position }) => ({ contactId, isPrimary, position })) };
}
