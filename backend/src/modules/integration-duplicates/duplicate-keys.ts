import { createHmac } from 'node:crypto';

/** Version of the server secret the keys of the cases are made with (rotation: offline, see the plan v3.5). */
export const KEY_VERSION = 1;

/**
 * The identity of a case: HMAC-SHA256 of the rule and the normalized key with the server secret. Without the secret
 * a short key (a phone of 10 digits, an IIN of 12) cannot be found by trying all values.
 */
export function caseKeyHash(secret: string, ruleCode: string, key: string): Buffer {
  return createHmac('sha256', secret).update(`${ruleCode}\u0000${key}`).digest();
}

export type MaskKind = 'phone' | 'bin' | 'name' | 'pair' | 'ref' | 'composite';

const MAX_MASK = 120;

/**
 * What a case shows as its key without anybody's rights to the values: the last two digits of a phone or an
 * identification number, a name only when no member is a person, never the key itself for a person.
 * `personal` — some member is an individual (a client of person type individual, a person in 1C).
 */
export function caseKeyMask(kind: MaskKind, key: string, personal: boolean): string {
  switch (kind) {
    case 'phone':
      return `+7 *** *** ** ${key.slice(-2)}`;
    case 'bin':
      return `ИИН/БИН ••••••••••${key.slice(-2)}`;
    case 'ref':
      return `ключ 1С …${key.slice(-4)}`;
    case 'pair':
      return 'похожие названия';
    case 'name':
      return personal ? 'ФИО (скрыто)' : clip(key);
    case 'composite':
      // «<name>:<qualifier…>» — the name part is shown (names of materials and companies are not personal data).
      return personal ? 'ФИО (скрыто)' : clip(key.split(':')[0] ?? '');
  }
}

function clip(text: string): string {
  const value = text.trim() || '—';
  return value.length > MAX_MASK ? `${value.slice(0, MAX_MASK - 1)}…` : value;
}
