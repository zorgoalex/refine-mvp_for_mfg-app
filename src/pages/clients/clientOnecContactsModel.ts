import type { SupplierOnecProfile } from '../../api/partyContactsApi';
import { onecProfileView } from '../suppliers/supplierCounterpartyModel';

export const CLIENT_ONEC_SYNC_OFF = 'PARTY_CONTACTS_ONEC_SYNC_OFF';

const UNAVAILABLE_STATES: ReadonlyArray<SupplierOnecProfile['contactsState']> = ['revoked', 'expired', 'unavailable'];

export interface ClientOnecStatusView {
  /** Nothing to say: no link, no sync yet, or the viewer may not see the 1C copy. */
  visible: boolean;
  syncedText: string | null;
  warnings: string[];
}

/** The line under the contacts of a client: when the copy from 1C was last synced and what is wrong with it. */
export function clientOnecStatusView(
  link: { refKey1c: string | null; onec?: SupplierOnecProfile | null } | null | undefined,
  now = new Date(),
): ClientOnecStatusView {
  const profile = link?.refKey1c ? link.onec : null;
  if (!profile) return { visible: false, syncedText: null, warnings: [] };
  const warnings: string[] = [];
  if (UNAVAILABLE_STATES.includes(profile.contactsState)) warnings.push('Данные 1С сейчас недоступны: контакты из 1С скрыты');
  if (profile.skipped > 0) warnings.push(`Не распознано значений из 1С: ${profile.skipped}`);
  return { visible: true, syncedText: onecProfileView(profile, now).syncedText, warnings };
}

/** «Сверить с 1С»: the sync is on, the client is linked, the user may both change the client and see the 1C data. */
export function canSyncClientOnec(
  link: { refKey1c: string | null; onecSyncEnabled?: boolean } | null | undefined,
  can: (permission: 'clients.update' | 'clients.onec_data.view') => boolean,
): boolean {
  return Boolean(link?.refKey1c && link.onecSyncEnabled) && can('clients.update') && can('clients.onec_data.view');
}

/**
 * A reload the page asked for later (after a link change the background sync brings the new contacts): it runs only
 * when no unsaved edit of the contacts would be lost and no change of them is in flight; until then it waits.
 */
export function deferredReloadNow(pending: boolean, contactsDirty: boolean, busy: boolean): boolean {
  return pending && !contactsDirty && !busy;
}
