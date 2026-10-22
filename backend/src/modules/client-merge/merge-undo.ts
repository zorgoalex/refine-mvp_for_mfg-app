import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import type { ClientCounterpartyRepository } from '../party-contacts/client-counterparty.repository';
import type { MergeContext, MergeItemKind } from './client-merge';
import { auditMovedOrders, bumpContactVersions } from './merge-apply';
import { fingerprint, readContacts, readOrders, readPhones, readProjects, type ContactState, type OrderState, type PhoneState, type ProjectState } from './merge-state';
import { normalizedPhone } from '../onec-agent/domain/onec-matching-sql';

export interface MergeRow {
  mergeId: number; caseId: number; survivorId: number; mergedId: number; status: 'done' | 'undone';
  actorUserId: number; actorName: string | null; mergedAt: string; undoUntil: string; undoneAt: string | null; undoneBy: number | null;
  undoneByName: string | null; counts: Record<string, number>; undoReport: UndoReport | null; purged: boolean; expired: boolean;
}

export interface JournalItem { itemNo: number; kind: MergeItemKind; rowId: number; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

export interface UndoSkip { kind: MergeItemKind; rowId: number; reason: string }
/** `orderIds`/`projectIds` — what came back (ids only), for counts by the reader's order visibility. */
export interface UndoReport { returned: Record<string, number>; skipped: UndoSkip[]; orderIds?: number[]; projectIds?: number[] }

/** What an undo would do now: computed from the journal and the current rows (no changes). */
export interface UndoPlan {
  projects: ProjectState[];
  looseOrderIds: number[];
  orderIds: number[];
  skipped: UndoSkip[];
  phonesBack: number[];
  phonesRestore: JournalItem[];
  keysBack: JournalItem[];
  contactsBack: number[];
  contactsRestore: JournalItem[];
  /** Survivor's 1C copies the merge dropped for a moved own row (K4b): given back only to the same link. */
  copiesRestore: JournalItem[];
  primaryPhone: number | null;
  primaryContacts: number[];
  onecLink: string | null;
  repointed: number[];
}

export async function readMerge(db: DatabaseClient, mergeId: number, lock: boolean): Promise<MergeRow | null> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT m.merge_id, m.case_id, m.survivor_id, m.merged_id, m.status, m.actor_user_id, ua.username::text AS actor_name,
            m.merged_at::text AS merged_at, m.undo_until::text AS undo_until, m.undone_at::text AS undone_at, m.undone_by,
            uu.username::text AS undone_by_name, m.counts, m.undo_report, m.journal_purged_at IS NOT NULL AS purged,
            m.undo_until <= now() AS expired
       FROM client_merges m LEFT JOIN users ua ON ua.user_id = m.actor_user_id LEFT JOIN users uu ON uu.user_id = m.undone_by
      WHERE m.merge_id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`, [mergeId])).rows[0];
  return r ? toMerge(r) : null;
}

export function toMerge(r: Record<string, unknown>): MergeRow {
  return {
    mergeId: Number(r.merge_id), caseId: Number(r.case_id), survivorId: Number(r.survivor_id), mergedId: Number(r.merged_id),
    status: r.status as MergeRow['status'], actorUserId: Number(r.actor_user_id), actorName: (r.actor_name as string | null) ?? null,
    mergedAt: String(r.merged_at), undoUntil: String(r.undo_until), undoneAt: (r.undone_at as string | null) ?? null,
    undoneBy: r.undone_by === null || r.undone_by === undefined ? null : Number(r.undone_by), undoneByName: (r.undone_by_name as string | null) ?? null,
    counts: (r.counts as Record<string, number>) ?? {}, undoReport: (r.undo_report as UndoReport | null) ?? null,
    purged: r.purged === true, expired: r.expired === true,
  };
}

export async function readJournal(db: DatabaseClient, mergeId: number): Promise<JournalItem[]> {
  return (await db.query<Record<string, unknown>>(
    'SELECT item_no, item_kind, row_id, before, after FROM client_merge_items WHERE merge_id = $1 ORDER BY item_no', [mergeId])).rows
    .map((r) => ({ itemNo: Number(r.item_no), kind: r.item_kind as MergeItemKind, rowId: Number(r.row_id),
      before: (r.before as Record<string, unknown> | null) ?? null, after: (r.after as Record<string, unknown> | null) ?? null }));
}

/** Later standing merges of either client: only the last merge of a chain is undone. */
export async function laterMerges(db: DatabaseClient, merge: MergeRow): Promise<number> {
  return (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM client_merges WHERE status = 'done' AND merge_id > $1
        AND (survivor_id = ANY($2::bigint[]) OR merged_id = ANY($2::bigint[]))`, [merge.mergeId, [merge.survivorId, merge.mergedId]])).rows[0].n;
}

/** The current state an undo depends on (projects of the journal with their current orders, both clients' phones and contacts). */
export interface UndoState {
  projects: ProjectState[];
  orders: OrderState[];
  phones: PhoneState[];
  contacts: ContactState[];
  refs: Map<number, string | null>;
  /** The 1C contacts profile of the survivor (source and key of the link its copies were made for). */
  survivorProfile: { sourceId: number; ref: string } | null;
  redirects: Array<{ mergedClientId: number; survivorId: number }>;
  aliasRequests: number;
  pendingOrderIds: number[];
  pendingPhoneIds: number[];
}

/** Unfinished WhatsApp sends of what the undo returns (its orders, its moved-back phones). */
export const undoSendsPending = (state: UndoState, plan: UndoPlan) =>
  state.pendingOrderIds.some((id) => plan.orderIds.includes(id)) || state.pendingPhoneIds.some((id) => plan.phonesBack.includes(id));

const journalIds = (items: readonly JournalItem[], kind: MergeItemKind) => items.filter((i) => i.kind === kind).map((i) => i.rowId);

export async function readUndoState(db: DatabaseClient, merge: MergeRow, items: readonly JournalItem[], lock: boolean): Promise<UndoState> {
  const s = merge.survivorId;
  const projectIds = journalIds(items, 'project');
  const projects = (await readProjects(db, s, false)).filter((p) => projectIds.includes(p.projectId));
  // The orders an undo may touch: those of the journal and every current order of the journal's groups.
  const orderIds = [...new Set([...journalIds(items, 'order'), ...projects.flatMap((p) => p.orderIds)])].sort((a, b) => a - b);
  if (lock && projects.length) {
    await db.query('SELECT project_id FROM projects WHERE project_id = ANY($1::bigint[]) ORDER BY project_id FOR NO KEY UPDATE', [projects.map((p) => p.projectId)]);
  }
  const orders = await readOrders(db, { orderIds }, lock);
  if (lock) {
    await db.query('SELECT client_id FROM clients WHERE client_id = ANY($1::bigint[]) ORDER BY client_id FOR UPDATE', [[s, merge.mergedId]]);
  }
  const phones = await readPhones(db, [s, merge.mergedId], lock);
  const contacts = await readContacts(db, [s, merge.mergedId], lock);
  const refs = new Map((await db.query<{ client_id: string; ref: string | null }>(
    'SELECT client_id, lower(ref_key_1c::text) AS ref FROM clients WHERE client_id = ANY($1::bigint[])', [[s, merge.mergedId]])).rows
    .map((r) => [Number(r.client_id), r.ref]));
  const profile = (await db.query<{ source_id: string; ref: string }>(
    `SELECT source_id, lower(ref_key_1c::text) AS ref FROM party_onec_profiles WHERE party_kind = 'client' AND party_id = $1`, [s])).rows[0];
  const aliases = [merge.mergedId, ...journalIds(items, 'redirect_repointed')];
  const redirects = (await db.query<{ merged_client_id: string; survivor_id: string }>(
    'SELECT merged_client_id, survivor_id FROM client_merge_redirects WHERE merged_client_id = ANY($1::bigint[]) ORDER BY merged_client_id', [aliases])).rows
    .map((r) => ({ mergedClientId: Number(r.merged_client_id), survivorId: Number(r.survivor_id) }));
  // A deal made after the merge on the contact of an alias belongs to the survivor; giving the alias back would leave it without a mapping.
  const aliasRequests = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bitrix24_incoming_request r
      WHERE r.client_id = $1 AND EXISTS (SELECT 1 FROM crm_sync_mapping mp WHERE mp.entity_type = 'client' AND mp.erp_id = ANY($2::text[])
        AND mp.bitrix_object = r.counterparty_object_type AND mp.bitrix_id = r.counterparty_bitrix_id)`, [s, aliases.map(String)])).rows[0].n;
  const movedPhoneIds = journalIds(items, 'phone_moved');
  // Unfinished sends of the orders and phones an undo may touch; the obstacle counts only those it actually returns.
  const pending = (await db.query<{ order_id: string | null; client_phone_id: string | null }>(
    `SELECT order_id, client_phone_id FROM whatsapp_order_sends WHERE state IN ('queued', 'sending', 'unknown')
        AND (order_id = ANY($1::bigint[]) OR client_phone_id = ANY($2::bigint[])) ORDER BY send_id`, [orderIds, movedPhoneIds])).rows;
  return {
    projects, orders, phones, contacts, refs, redirects, aliasRequests,
    survivorProfile: profile ? { sourceId: Number(profile.source_id), ref: profile.ref } : null,
    pendingOrderIds: [...new Set(pending.filter((r) => r.order_id !== null).map((r) => Number(r.order_id)))].sort((a, b) => a - b),
    pendingPhoneIds: [...new Set(pending.filter((r) => r.client_phone_id !== null).map((r) => Number(r.client_phone_id)))].sort((a, b) => a - b),
  };
}

export function undoFingerprint(merge: MergeRow, state: UndoState): string {
  return fingerprint({
    merge: [merge.mergeId, merge.status],
    projects: state.projects.map((p) => [p.projectId, p.version, p.clientId, p.orderIds]),
    orders: state.orders.map((o) => [o.orderId, o.version, o.projectId, o.clientId]),
    phones: state.phones.map((p) => [p.phoneId, p.clientId, p.number, p.type, p.isPrimary, p.ref]),
    contacts: state.contacts.map((c) => [c.contactId, c.clientId, c.kind, c.valueNormalized, c.isPrimary, c.note]),
    refs: [...state.refs.entries()].sort(([a], [b]) => a - b),
    survivorProfile: state.survivorProfile ? [state.survivorProfile.sourceId, state.survivorProfile.ref] : null,
    redirects: state.redirects.map((r) => [r.mergedClientId, r.survivorId]),
    blockers: [state.aliasRequests, state.pendingOrderIds, state.pendingPhoneIds],
  });
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/** Decides, row by row, what an undo returns now and what it leaves (with the reason). */
export function planUndo(merge: MergeRow, items: readonly JournalItem[], state: UndoState): UndoPlan {
  const s = merge.survivorId;
  const m = merge.mergedId;
  const skipped: UndoSkip[] = [];
  const plan: UndoPlan = {
    projects: [], looseOrderIds: [], orderIds: [], skipped, phonesBack: [], phonesRestore: [], keysBack: [], contactsBack: [],
    contactsRestore: [], copiesRestore: [], primaryPhone: null, primaryContacts: [], onecLink: null, repointed: [],
  };
  const ordersById = new Map(state.orders.map((o) => [o.orderId, o]));
  for (const item of items.filter((i) => i.kind === 'project')) {
    const current = state.projects.find((p) => p.projectId === item.rowId);
    const recorded = ((item.after?.orderIds as number[] | undefined) ?? []).map(Number);
    if (!current) { skipped.push({ kind: 'project', rowId: item.rowId, reason: 'group_moved' }); continue; }
    // A group comes back only as it was: a group whose orders changed stays (its cascade would carry orders the merge never moved).
    if (!sameIds(current.orderIds, recorded)) { skipped.push({ kind: 'project', rowId: item.rowId, reason: 'group_changed' }); continue; }
    plan.projects.push(current);
    plan.orderIds.push(...current.orderIds);
  }
  for (const item of items.filter((i) => i.kind === 'order')) {
    const order = ordersById.get(item.rowId);
    const projectId = (item.after?.projectId as number | null | undefined) ?? null;
    if (projectId !== null) {
      if (plan.orderIds.includes(item.rowId)) continue;
      if (order && order.projectId !== projectId && order.clientId === s) skipped.push({ kind: 'order', rowId: item.rowId, reason: 'order_moved' });
      else if (!order || order.clientId !== s) skipped.push({ kind: 'order', rowId: item.rowId, reason: 'client_changed' });
      else skipped.push({ kind: 'order', rowId: item.rowId, reason: 'group_changed' });
      continue;
    }
    if (order && order.clientId === s && order.projectId === null) { plan.looseOrderIds.push(order.orderId); plan.orderIds.push(order.orderId); }
    else skipped.push({ kind: 'order', rowId: item.rowId, reason: order && order.clientId === s ? 'order_moved' : 'client_changed' });
  }
  plan.orderIds.sort((a, b) => a - b);

  const phone = (id: number) => state.phones.find((p) => p.phoneId === id);
  const mergedPhones = state.phones.filter((p) => p.clientId === m);
  for (const item of items.filter((i) => i.kind === 'phone_moved')) {
    const current = phone(item.rowId);
    const after = item.after ?? {};
    if (current && current.clientId === s && current.number === after.phoneNumber && current.type === (after.phoneType ?? null) && current.ref === (after.refKey1c ?? null)) {
      plan.phonesBack.push(current.phoneId);
    } else skipped.push({ kind: 'phone_moved', rowId: item.rowId, reason: current ? 'changed_after_merge' : 'deleted_after_merge' });
  }
  for (const item of items.filter((i) => i.kind === 'phone_key_moved')) {
    const current = phone(item.rowId);
    if (current && current.clientId === s && current.ref === (item.after?.refKey1c ?? null)) plan.keysBack.push(item);
    else skipped.push({ kind: 'phone_key_moved', rowId: item.rowId, reason: 'changed_after_merge' });
  }
  for (const item of items.filter((i) => i.kind === 'phone_deleted')) {
    if (!item.before) { skipped.push({ kind: 'phone_deleted', rowId: item.rowId, reason: 'journal_purged' }); continue; }
    if (mergedPhones.some((p) => p.number === item.before!.phoneNumber)) skipped.push({ kind: 'phone_deleted', rowId: item.rowId, reason: 'value_exists' });
    else plan.phonesRestore.push(item);
  }
  // A key goes back only with the row it came from.
  plan.keysBack = plan.keysBack.filter((k) => plan.phonesRestore.some((r) => r.rowId === Number(k.before?.fromPhoneId)));
  for (const k of items.filter((i) => i.kind === 'phone_key_moved')) {
    if (!plan.keysBack.includes(k) && !skipped.some((x) => x.kind === 'phone_key_moved' && x.rowId === k.rowId)) {
      skipped.push({ kind: 'phone_key_moved', rowId: k.rowId, reason: 'phone_not_restored' });
    }
  }
  const formerPrimaryPhone = [...items.filter((i) => i.kind === 'phone_moved'), ...items.filter((i) => i.kind === 'phone_deleted')]
    .find((i) => i.before?.isPrimary === true);
  if (formerPrimaryPhone && !mergedPhones.some((p) => p.isPrimary)) plan.primaryPhone = formerPrimaryPhone.rowId;

  const contact = (id: number) => state.contacts.find((c) => c.contactId === id);
  const mergedContacts = state.contacts.filter((c) => c.clientId === m);
  for (const item of items.filter((i) => i.kind === 'contact_moved')) {
    const current = contact(item.rowId);
    const after = item.after ?? {};
    if (current && current.clientId === s && current.kind === after.kind && current.valueNormalized === after.valueNormalized && current.note === (after.note ?? null)) {
      plan.contactsBack.push(current.contactId);
    } else skipped.push({ kind: 'contact_moved', rowId: item.rowId, reason: current ? 'changed_after_merge' : 'deleted_after_merge' });
  }
  const survivorCopies: JournalItem[] = [];
  for (const item of items.filter((i) => i.kind === 'contact_deleted')) {
    if (!item.before) { skipped.push({ kind: 'contact_deleted', rowId: item.rowId, reason: 'journal_purged' }); continue; }
    if (item.before.origin !== 'erp') {
      // The survivor's copy dropped for a moved own row is decided after the 1C link below; the merged client's copies stay gone.
      if (Number(item.before.clientId) === s && item.before.refKey1c) survivorCopies.push(item);
      else skipped.push({ kind: 'contact_deleted', rowId: item.rowId, reason: 'onec_copy' });
      continue;
    }
    if (mergedContacts.some((c) => c.kind === item.before!.kind && c.valueNormalized === item.before!.valueNormalized)) {
      skipped.push({ kind: 'contact_deleted', rowId: item.rowId, reason: 'value_exists' });
    } else plan.contactsRestore.push(item);
  }
  for (const item of [...items.filter((i) => i.kind === 'contact_moved'), ...items.filter((i) => i.kind === 'contact_deleted')]) {
    if (item.before?.isPrimary !== true || item.before.origin !== 'erp') continue;
    if (mergedContacts.some((c) => c.kind === item.before!.kind && c.isPrimary)) continue;
    plan.primaryContacts.push(item.rowId);
  }

  const link = items.find((i) => i.kind === 'onec_link');
  if (link) {
    const ref = String(link.after?.refKey1c ?? '');
    if (state.refs.get(s) === ref && state.refs.get(m) === null) plan.onecLink = ref;
    else skipped.push({ kind: 'onec_link', rowId: link.rowId, reason: 'link_changed' });
  }
  // K4b: a survivor's copy comes back only to the very link and profile it was made for, as the only row of its value and,
  // when it was «основной», with no other «основной» of its kind on the survivor after the undo.
  const survivorAfter = state.contacts.filter((c) => c.clientId === s && !plan.contactsBack.includes(c.contactId));
  for (const item of survivorCopies) {
    const b = item.before!;
    const sameLink = plan.onecLink === null && state.refs.get(s) === b.refKey1c && state.survivorProfile !== null
      && state.survivorProfile.ref === b.refKey1c && state.survivorProfile.sourceId === Number(b.onecSourceId);
    if (!sameLink) skipped.push({ kind: 'contact_deleted', rowId: item.rowId, reason: 'onec_copy_relinked' });
    else if (survivorAfter.some((c) => c.kind === b.kind && c.valueNormalized === b.valueNormalized)) skipped.push({ kind: 'contact_deleted', rowId: item.rowId, reason: 'value_exists' });
    else if (b.isPrimary === true && survivorAfter.some((c) => c.kind === b.kind && c.isPrimary)) skipped.push({ kind: 'contact_deleted', rowId: item.rowId, reason: 'primary_taken' });
    else plan.copiesRestore.push(item);
  }
  for (const item of items.filter((i) => i.kind === 'redirect_repointed')) {
    if (state.redirects.some((r) => r.mergedClientId === item.rowId && r.survivorId === s)) plan.repointed.push(item.rowId);
    else skipped.push({ kind: 'redirect_repointed', rowId: item.rowId, reason: 'changed_after_merge' });
  }
  return plan;
}

/** Applies an undo under the locks of the caller. The redirect goes first: the guards would refuse every reference otherwise. */
export async function applyUndo(
  tx: TransactionClient, merge: MergeRow, items: readonly JournalItem[], plan: UndoPlan, actor: CurrentUser, ctx: MergeContext,
  links: ClientCounterpartyRepository,
): Promise<UndoReport> {
  const s = merge.survivorId;
  const m = merge.mergedId;
  const actorId = Number(actor.id);
  await tx.query('SELECT set_session_user($1)', [actor.id]);
  await tx.query('DELETE FROM client_merge_redirects WHERE merged_client_id = $1 AND merge_id = $2', [m, merge.mergeId]);
  if (plan.repointed.length) {
    await tx.query('UPDATE client_merge_redirects SET survivor_id = $2 WHERE merged_client_id = ANY($1::bigint[]) AND survivor_id = $3', [plan.repointed, m, s]);
  }
  await tx.query('UPDATE clients SET is_active = true, edited_by = $2 WHERE client_id = $1', [m, actorId]);

  for (const project of plan.projects) {
    await tx.query('UPDATE projects SET client_id = $2, version = version + 1, edited_by = $3 WHERE project_id = $1', [project.projectId, m, actorId]);
  }
  if (plan.looseOrderIds.length) await tx.query('UPDATE orders SET client_id = $2 WHERE order_id = ANY($1::bigint[])', [plan.looseOrderIds, m]);
  if (plan.orderIds.length) await tx.query('UPDATE orders SET version = version + 1 WHERE order_id = ANY($1::bigint[])', [plan.orderIds]);

  if (plan.phonesBack.length) await tx.query('UPDATE client_phones SET client_id = $2, is_primary = false WHERE phone_id = ANY($1::bigint[])', [plan.phonesBack, m]);
  const skipped = [...plan.skipped];
  // A 1C key that moved to the survivor's row goes back to the restored row; a key another row took meanwhile stays there.
  const keyFor = new Map<number, string>();
  for (const item of plan.keysBack) {
    await tx.query('UPDATE client_phones SET ref_key_1c = NULL WHERE phone_id = $1', [item.rowId]);
    const from = Number(item.before?.fromPhoneId);
    if (Number.isFinite(from)) keyFor.set(from, String(item.after?.refKey1c));
  }
  let restoredPhones = 0;
  for (const item of plan.phonesRestore) {
    const b = item.before!;
    const ref = keyFor.get(item.rowId) ?? (b.refKey1c as string | null) ?? null;
    const insert = async (withRef: string | null) => tx.query(
      `INSERT INTO client_phones (phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c)
       VALUES (CASE WHEN EXISTS (SELECT 1 FROM client_phones WHERE phone_id = $1) THEN nextval(pg_get_serial_sequence('client_phones', 'phone_id')) ELSE $1 END,
               $2, $3, $4, false, $5::uuid)`, [item.rowId, m, b.phoneNumber, b.phoneType === undefined ? 'mobile' : b.phoneType, withRef]);
    if (ref) {
      await tx.query('SAVEPOINT client_merge_phone');
      try {
        await insert(ref);
        await tx.query('RELEASE SAVEPOINT client_merge_phone');
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT client_merge_phone');
        if ((error as { code?: string }).code !== '23505') throw error;
        await insert(null);
        skipped.push({ kind: 'phone_deleted', rowId: item.rowId, reason: 'onec_key_taken' });
      }
    } else {
      await insert(null);
    }
    restoredPhones += 1;
  }
  if (plan.primaryPhone !== null) {
    await tx.query(
      `UPDATE client_phones SET is_primary = true
        WHERE client_id = $1 AND NOT EXISTS (SELECT 1 FROM client_phones x WHERE x.client_id = $1 AND x.is_primary)
          AND phone_id = (SELECT p.phone_id FROM client_phones p WHERE p.client_id = $1
                           AND ${normalizedPhone('p.phone_number')} = (SELECT ${normalizedPhone('$2::text')}) ORDER BY p.phone_id LIMIT 1)`,
      [m, String(items.find((i) => i.rowId === plan.primaryPhone && (i.kind === 'phone_moved' || i.kind === 'phone_deleted'))?.before?.phoneNumber ?? '')]);
  }

  if (plan.contactsBack.length) {
    await tx.query('UPDATE client_contacts SET client_id = $2, is_primary = false, updated_by = $3, updated_at = now() WHERE contact_id = ANY($1::bigint[])',
      [plan.contactsBack, m, actorId]);
  }
  for (const item of plan.contactsRestore) {
    const b = item.before!;
    // The original id comes back (a later undo of an earlier merge finds the row by it).
    await tx.query(
      `INSERT INTO client_contacts (contact_id, client_id, kind, value, value_normalized, is_primary, note, position, created_by, updated_by)
       VALUES (CASE WHEN EXISTS (SELECT 1 FROM client_contacts WHERE contact_id = $8) THEN nextval(pg_get_serial_sequence('client_contacts', 'contact_id')) ELSE $8 END,
               $1, $2, $3, $4, false, $5, $6, $7, $7)`, [m, b.kind, b.value, b.valueNormalized, b.note ?? null, Number(b.position ?? 0), actorId, item.rowId]);
  }
  for (const contactItemRow of plan.primaryContacts) {
    const item = items.find((i) => i.rowId === contactItemRow && (i.kind === 'contact_moved' || i.kind === 'contact_deleted'));
    if (!item?.before) continue;
    await tx.query(
      `UPDATE client_contacts SET is_primary = true WHERE client_id = $1 AND kind = $2 AND value_normalized = $3
          AND NOT EXISTS (SELECT 1 FROM client_contacts x WHERE x.client_id = $1 AND x.kind = $2 AND x.is_primary)`,
      [m, item.before.kind, item.before.valueNormalized]);
  }
  for (const item of plan.copiesRestore) {
    const b = item.before!;
    // The copy as it was (its id, its «основной», its snapshot): shown again once its snapshot is current (the sync restamps it).
    await tx.query(
      `INSERT INTO client_contacts (contact_id, client_id, kind, value, value_normalized, is_primary, note, position, origin, onec_source_id,
           onec_snapshot_version, onec_synced_at)
       VALUES (CASE WHEN EXISTS (SELECT 1 FROM client_contacts WHERE contact_id = $1) THEN nextval(pg_get_serial_sequence('client_contacts', 'contact_id')) ELSE $1 END,
               $2, $3, $4, $5, $6, NULL, $7, 'onec', $8, $9::timestamptz, $10::timestamptz)`,
      [item.rowId, s, b.kind, b.value, b.valueNormalized, b.isPrimary === true, Number(b.position ?? 99), Number(b.onecSourceId), b.onecSnapshotVersion, b.onecSyncedAt]);
  }
  await bumpContactVersions(tx, [s, m]);

  if (plan.onecLink) {
    await links.transferLink(tx, { fromClientId: s, toClientId: m, refKey1c: plan.onecLink, actor, requestId: ctx.requestId, via: 'merge_undo', mergeId: merge.mergeId });
  }

  const report: UndoReport = {
    returned: {
      projects: plan.projects.length, orders: plan.orderIds.length, phonesMoved: plan.phonesBack.length, phonesRestored: restoredPhones,
      contactsMoved: plan.contactsBack.length, contactsRestored: plan.contactsRestore.length, onecCopiesRestored: plan.copiesRestore.length,
      onecLink: plan.onecLink ? 1 : 0,
      redirectsRestored: plan.repointed.length,
    },
    skipped,
    orderIds: plan.orderIds,
    projectIds: plan.projects.map((p) => p.projectId),
  };
  await tx.query(
    `UPDATE client_merges SET status = 'undone', undone_at = now(), undone_by = $2, undo_request_id = $3, undo_report = $4::jsonb WHERE merge_id = $1`,
    [merge.mergeId, actorId, ctx.requestId, JSON.stringify(report)]);
  await auditMovedOrders(tx, plan.orderIds, s, m, merge.mergeId, actor, ctx, 'client_merge_undo');
  return report;
}
