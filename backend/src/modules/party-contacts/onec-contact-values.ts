import type { OnecCounterpartyContact } from '../onec-agent/onec-catalog-reader';
import { PARTY_ADDRESS_MAX, PARTY_ONEC_CONTACTS_MAX, type PartyContactKind } from './party-contacts';
import { normalizePartyContact } from './party-contact-values';

export interface OnecValue { kind: PartyContactKind; value: string; valueNormalized: string }

const formatPhone = (normalized: string) => `+7 ${normalized.slice(1, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 9)} ${normalized.slice(9)}`;

const tryNormalize = (kind: PartyContactKind, raw: string | null): string | null => {
  if (!raw) return null;
  try {
    return normalizePartyContact(kind, raw);
  } catch {
    return null;
  }
};

/**
 * What the contacts of a 1C counterparty become in ERP: phones (the number field, else the presentation, by the ERP
 * phone rule), emails (lower case), addresses (the presentation). The 1C line number is not an identity: the set is
 * compared by values. Other types (Skype, web pages…) are left out; an unreadable value counts as skipped; a value
 * repeated in 1C comes once; at most PARTY_ONEC_CONTACTS_MAX values per owner (the rest are skipped).
 */
export function onecContactValues(contacts: readonly OnecCounterpartyContact[]): { values: OnecValue[]; skipped: number } {
  const values: OnecValue[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const contact of [...contacts].sort((left, right) => left.lineNo - right.lineNo)) {
    if (contact.type === 'other') continue;
    let value: OnecValue | null = null;
    if (contact.type === 'phone') {
      const normalized = tryNormalize('phone', contact.phoneNumber) ?? tryNormalize('phone', contact.presentation);
      // The presentation of 1C is shown only when it reads as this very number; otherwise the number itself.
      const shown = (contact.presentation ?? '').trim();
      if (normalized) {
        value = { kind: 'phone', value: shown.length <= 200 && tryNormalize('phone', shown) === normalized ? shown : formatPhone(normalized), valueNormalized: normalized };
      }
    } else if (contact.type === 'email') {
      const normalized = tryNormalize('email', contact.email) ?? tryNormalize('email', contact.presentation);
      if (normalized && normalized.length <= 200) value = { kind: 'email', value: normalized, valueNormalized: normalized };
    } else {
      const shown = (contact.presentation ?? '').trim().replace(/\s+/g, ' ');
      const normalized = shown.length <= PARTY_ADDRESS_MAX ? tryNormalize('address', shown) : null;
      if (normalized) value = { kind: 'address', value: shown, valueNormalized: normalized };
    }
    if (!value) { skipped += 1; continue; }
    const key = `${value.kind}:${value.valueNormalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (values.length >= PARTY_ONEC_CONTACTS_MAX) { skipped += 1; continue; }
    values.push(value);
  }
  return { values, skipped };
}
