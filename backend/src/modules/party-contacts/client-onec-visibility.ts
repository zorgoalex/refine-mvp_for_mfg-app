import { normalizedClientPhoneSql } from '../whatsapp/order-send/order-send-phone';

/**
 * K4b: may a row of client_contacts (alias `c`) be shown and used now. The client's own rows — always. A copy of 1C —
 * only when (1) the reader has `clients.onec_data.view` (`withData`, a literal from code), (2) its 1C data may be used
 * now (party_onec_contacts_available: not revoked, not expired, the current snapshot), (3) it was made for the current
 * link of the client (the profile of the same source and key as `clients.ref_key_1c`), and (4) a phone copy is not a
 * number the client already has in client_phones — by the very rule the sync uses (`normalizeClientPhone`) — until the
 * sync drops such a copy.
 */
export function clientOnecCopyVisible(c: string, withData: boolean): string {
  if (!withData) return `(${c}.origin = 'erp')`;
  return `(${c}.origin = 'erp' OR (party_onec_contacts_available(${c}.onec_source_id, ${c}.onec_snapshot_version)
    AND EXISTS (SELECT 1 FROM party_onec_profiles pp JOIN clients pc ON pc.client_id = pp.party_id
                 WHERE pp.party_kind = 'client' AND pp.party_id = ${c}.client_id AND pp.source_id = ${c}.onec_source_id
                   AND pp.ref_key_1c = pc.ref_key_1c)
    AND NOT (${c}.kind = 'phone' AND EXISTS (SELECT 1 FROM client_phones cp WHERE cp.client_id = ${c}.client_id
                 AND ${normalizedClientPhoneSql('cp.phone_number')} = ${c}.value_normalized))))`;
}

/** The permission that opens the 1C data of clients (copies of contacts, phones and ИИН/БИН of the counterparty). */
export const CLIENT_ONEC_DATA_VIEW = 'clients.onec_data.view';
