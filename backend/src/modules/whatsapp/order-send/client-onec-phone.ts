import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { CLIENT_ONEC_DATA_VIEW, clientOnecCopyVisible } from '../../party-contacts/client-onec-visibility';

/**
 * K4b-2: a phone of the client from 1C (a copy in client_contacts, origin 'onec', kind 'phone') as the recipient of an
 * order send. Lock order of every check: (actor) → order FOR SHARE → client FOR UPDATE → the copy FOR SHARE → the state
 * of its 1C set FOR SHARE (`party_onec_contacts_lock`) — the client before the 1C state, as the K4b sync; the link
 * commands and a merge take the client too, so none of them can drop or move the copy until the caller commits.
 */

/** The 1C data must stay usable this long past the check: before the WAHA number check (the lock holding bound). */
export const ONEC_PHONE_CHECK_MARGIN_MS = 10_000;
/** … and at the command and at the intent, which is followed by the delivery right after its commit. */
export const ONEC_PHONE_SEND_MARGIN_MS = 60_000;

export interface ClientOnecPhoneRow extends QueryResultRow {
  contact_id: string; client_id: string; value_normalized: string; onec_source_id: string; onec_snapshot_version: Date;
}

export const hasClientOnecData = (user: CurrentUser): boolean => user.permissions.includes(CLIENT_ONEC_DATA_VIEW);

/** The copy `contactId` of the client, share-locked; null when it is not a 1C phone of this client (any more). */
export async function lockClientOnecPhone(tx: DatabaseClient, clientId: number, contactId: number): Promise<ClientOnecPhoneRow | null> {
  return (await tx.query<ClientOnecPhoneRow>(`SELECT contact_id, client_id, value_normalized, onec_source_id, onec_snapshot_version
    FROM client_contacts WHERE contact_id = $1 AND client_id = $2 AND origin = 'onec' AND kind = 'phone' FOR SHARE`,
  [contactId, clientId])).rows[0] ?? null;
}

/**
 * May this copy be used now, with `marginMs` to spare: its 1C set is share-locked first (a revocation or a new snapshot
 * waits for the caller's commit, or has happened and is seen), then the visibility rule of K4b (the current link, not
 * hidden by an own phone) and a fresh expiry check by the wall clock — `party_onec_contacts_available` compares with the
 * transaction start, and the caller may have waited for its locks.
 */
export async function clientOnecPhoneUsable(tx: DatabaseClient, copy: ClientOnecPhoneRow, marginMs: number): Promise<boolean> {
  const locked = (await tx.query<{ ok: boolean }>('SELECT party_onec_contacts_lock($1::bigint, $2::timestamptz) AS ok',
    [copy.onec_source_id, copy.onec_snapshot_version])).rows[0]?.ok === true;
  if (!locked) return false;
  const row = (await tx.query<{ visible: boolean; fresh: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM client_contacts c WHERE c.contact_id = $1 AND ${clientOnecCopyVisible('c', true)}) AS visible,
      EXISTS (SELECT 1 FROM onec_etl_entity_state s WHERE s.source_id = $2 AND s.entity_code = 'counterparty_contacts'
               AND s.revoked_at IS NULL AND date_trunc('milliseconds', s.snapshot_version) = date_trunc('milliseconds', $3::timestamptz)
               -- 30 days: PERSONAL_DATA_TTL of 1C, as in party_onec_contacts_available (migration 243).
               AND s.snapshot_version >= clock_timestamp() - interval '30 days' + $4::int * interval '1 millisecond') AS fresh`,
  [copy.contact_id, copy.onec_source_id, copy.onec_snapshot_version, marginMs])).rows[0];
  return row?.visible === true && row.fresh === true;
}

export type ClientOnecPhoneCheck =
  | { ok: true; copy: ClientOnecPhoneRow }
  | { ok: false; reason: 'permission_revoked' | 'recipient_removed' | 'recipient_changed' | 'disabled' };

/**
 * The whole check of a queued send to a 1C phone, under the caller's transaction (the actor and the order are already
 * loaded by it, the order share-locked): the feature is on, the author may see 1C data, the order still has this client,
 * the copy is there with the same number and may be used for `marginMs` more.
 */
export async function checkQueuedClientOnecPhone(tx: DatabaseClient, input: {
  enabled: boolean; actor: CurrentUser; orderId: number; clientId: string | null; contactId: number; phoneNormalized: string | null; marginMs: number;
}): Promise<ClientOnecPhoneCheck> {
  if (!input.enabled) return { ok: false, reason: 'disabled' };
  if (!hasClientOnecData(input.actor)) return { ok: false, reason: 'permission_revoked' };
  const order = (await tx.query<{ client_id: string | null }>(`SELECT client_id FROM orders
    WHERE order_id = $1 AND delete_flag = false AND deleted_at IS NULL FOR SHARE`, [input.orderId])).rows[0];
  if (!order || order.client_id === null || String(order.client_id) !== String(input.clientId ?? '')) return { ok: false, reason: 'recipient_changed' };
  await tx.query('SELECT 1 FROM clients WHERE client_id = $1 FOR UPDATE', [order.client_id]);
  const copy = await lockClientOnecPhone(tx, Number(order.client_id), input.contactId);
  if (!copy) return { ok: false, reason: 'recipient_removed' };
  if (copy.value_normalized !== input.phoneNormalized) return { ok: false, reason: 'recipient_changed' };
  if (!(await clientOnecPhoneUsable(tx, copy, input.marginMs))) return { ok: false, reason: 'recipient_removed' };
  return { ok: true, copy };
}

/** A held lock of the 1C path (lock_timeout): a busy answer, never a final refusal. */
export function onecPhoneBusy(error: unknown): ApiError | null {
  return (error as { code?: unknown } | null)?.code === '55P03'
    ? new ApiError(503, 'ORDER_SEND_BUSY', 'Отправка из карточки занята; повторите запрос') : null;
}
