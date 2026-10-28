import { auditService } from '../../common/audit/audit.service';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import type { ClientCounterpartyRepository } from '../party-contacts/client-counterparty.repository';
import { MAX_CONTACTS, SOURCE, UNDO_TERM_DAYS, type MergeContext, type MergeItemKind } from './client-merge';
import type { ContactState, PairState, PhoneState } from './merge-state';

/** One change of a merge, kept for its undo. */
export interface MergeItem {
  kind: MergeItemKind;
  rowId: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface PhonePlan {
  move: PhoneState[];
  drop: Array<{ phone: PhoneState; match: PhoneState; keyMoves: boolean; keyLost: boolean }>;
  primary: { phoneId: number } | null;
}

export interface ContactPlan {
  move: ContactState[];
  drop: Array<{ contact: ContactState; match: ContactState | null }>;
  primary: Array<{ contactId: number; kind: string }>;
  total: number;
}

/**
 * What happens to the phones: a number the survivor already has (by the normalized number of the `client.phone` rule) is
 * dropped from the merged client — its 1C key moves to the survivor's row when that row has none; another number moves as
 * not primary. The survivor keeps its primary; without one, the merged client's primary (moved or matched) becomes it.
 */
export function planPhones(state: PairState): PhonePlan {
  const own = state.phones.filter((p) => p.clientId === state.survivor.clientId);
  const theirs = state.phones.filter((p) => p.clientId === state.merged.clientId);
  const plan: PhonePlan = { move: [], drop: [], primary: null };
  // The 1C key a survivor's row will have after the earlier drops of this plan: two duplicates of one number with keys
  // give the first key to the row and lose the second (reported), never overwrite it.
  const keyAfter = new Map(own.map((p) => [p.phoneId, p.ref]));
  for (const phone of theirs) {
    const match = phone.key !== '' ? own.find((p) => p.key === phone.key) : undefined;
    if (!match) { plan.move.push(phone); continue; }
    const taken = keyAfter.get(match.phoneId) ?? null;
    const keyMoves = phone.ref !== null && taken === null;
    if (keyMoves) keyAfter.set(match.phoneId, phone.ref);
    plan.drop.push({ phone, match, keyMoves, keyLost: phone.ref !== null && !keyMoves });
  }
  if (!own.some((p) => p.isPrimary)) {
    const formerPrimary = theirs.find((p) => p.isPrimary);
    if (formerPrimary) {
      const dropped = plan.drop.find((d) => d.phone.phoneId === formerPrimary.phoneId);
      plan.primary = { phoneId: dropped ? dropped.match.phoneId : formerPrimary.phoneId };
    }
  }
  return plan;
}

/**
 * Contacts: the same (kind, normalized value) as the survivor's own row is dropped from the merged client; 1C copies of the
 * merged client are dropped (their sync brings them back by the link). A survivor's 1C copy with the value of a merged
 * client's own row is dropped and the own row moves (K4b: the user's value must not depend on a link to 1C); when that
 * copy was the survivor's «основной» of its kind and no own row of the survivor is, the moved row becomes it.
 */
export function planContacts(state: PairState): ContactPlan {
  const own = state.contacts.filter((c) => c.clientId === state.survivor.clientId);
  const ownErp = own.filter((c) => c.origin === 'erp');
  const theirs = state.contacts.filter((c) => c.clientId === state.merged.clientId);
  const plan: ContactPlan = { move: [], drop: [], primary: [], total: 0 };
  const survivorCopies: ContactState[] = [];
  for (const contact of theirs) {
    if (contact.origin !== 'erp') { plan.drop.push({ contact, match: null }); continue; }
    const match = ownErp.find((c) => c.kind === contact.kind && c.valueNormalized === contact.valueNormalized);
    if (match) { plan.drop.push({ contact, match }); continue; }
    plan.move.push(contact);
    const copy = own.find((c) => c.origin !== 'erp' && c.kind === contact.kind && c.valueNormalized === contact.valueNormalized);
    if (copy) { plan.drop.push({ contact: copy, match: contact }); survivorCopies.push(copy); }
  }
  // «Основной» of the survivor after the drops: its own rows keep theirs; a dropped copy hands its flag to the moved row.
  const survivorHas = (kind: string) => own.some((c) => c.kind === kind && c.isPrimary && !survivorCopies.includes(c));
  for (const copy of survivorCopies.filter((c) => c.isPrimary)) {
    if (survivorHas(copy.kind)) continue;
    const moved = plan.move.find((c) => c.kind === copy.kind && c.valueNormalized === copy.valueNormalized)!;
    plan.primary.push({ contactId: moved.contactId, kind: copy.kind });
  }
  for (const kind of new Set(theirs.filter((c) => c.isPrimary && c.origin === 'erp').map((c) => c.kind))) {
    if (survivorHas(kind) || plan.primary.some((p) => p.kind === kind)) continue;
    const former = theirs.find((c) => c.kind === kind && c.isPrimary)!;
    const dropped = plan.drop.find((d) => d.contact.contactId === former.contactId);
    plan.primary.push({ contactId: dropped?.match ? dropped.match.contactId : former.contactId, kind });
  }
  plan.total = own.filter((c) => c.origin === 'erp').length + plan.move.length;
  return plan;
}

export const contactsOverLimit = (plan: ContactPlan) => plan.total > MAX_CONTACTS;

const phoneRow = (p: PhoneState) => ({ clientId: p.clientId, phoneNumber: p.number, phoneType: p.type, isPrimary: p.isPrimary, refKey1c: p.ref });
const contactRow = (c: ContactState) => ({
  clientId: c.clientId, kind: c.kind, value: c.value, valueNormalized: c.valueNormalized, isPrimary: c.isPrimary, note: c.note, position: c.position, origin: c.origin,
  // A 1C copy: what an undo needs to give it back to the same link (K4b); erased with the journal after the undo term.
  ...(c.origin !== 'erp' ? {
    onecSourceId: c.onecSourceId, onecSnapshotVersion: c.onecSnapshotVersion, onecSyncedAt: c.onecSyncedAt, refKey1c: c.onecRefKey1c,
  } : {}),
});

export interface AppliedMerge {
  mergeId: number;
  movedOrderIds: number[];
  counts: Record<string, number>;
}

/**
 * Applies a merge under the locks the caller took (see the service). Every change goes to the journal; the merged client
 * is made inactive and gets its redirect. CRM triggers run as usual (no `app.crm_sync_origin`): the moved orders and both
 * clients are queued for Bitrix.
 */
export async function applyMerge(
  tx: TransactionClient, state: PairState, caseId: number, actor: CurrentUser, ctx: MergeContext, links: ClientCounterpartyRepository,
): Promise<AppliedMerge> {
  const s = state.survivor.clientId;
  const m = state.merged.clientId;
  const items: MergeItem[] = [];
  await tx.query('SELECT set_session_user($1)', [actor.id]);
  // The operation first: every change below (the 1C link audit too) refers to it.
  const mergeId = Number((await tx.query<{ merge_id: string }>(
    `INSERT INTO client_merges (case_id, survivor_id, merged_id, status, actor_user_id, request_id, correlation_id, undo_until)
     VALUES ($1, $2, $3, 'done', $4, $5, $6, now() + make_interval(days => $7)) RETURNING merge_id`,
    [caseId, s, m, Number(actor.id), ctx.requestId, ctx.correlationId, UNDO_TERM_DAYS])).rows[0].merge_id);

  // Groups (their orders follow by the cascade of the composite key), then orders without a group; all orders get a new version.
  for (const project of state.projects) {
    await tx.query('UPDATE projects SET client_id = $2, version = version + 1, edited_by = $3 WHERE project_id = $1', [project.projectId, s, Number(actor.id)]);
    items.push({ kind: 'project', rowId: project.projectId, before: { clientId: m, version: project.version, orderIds: project.orderIds },
      after: { clientId: s, version: project.version + 1, orderIds: project.orderIds } });
  }
  const loose = state.orders.filter((o) => o.projectId === null).map((o) => o.orderId);
  if (loose.length) await tx.query('UPDATE orders SET client_id = $2 WHERE order_id = ANY($1::bigint[])', [loose, s]);
  const orderIds = state.orders.map((o) => o.orderId);
  if (orderIds.length) await tx.query('UPDATE orders SET version = version + 1 WHERE order_id = ANY($1::bigint[])', [orderIds]);
  for (const order of state.orders) {
    items.push({ kind: 'order', rowId: order.orderId, before: { clientId: m, version: order.version, projectId: order.projectId },
      after: { clientId: s, version: order.version + 1, projectId: order.projectId } });
  }

  // Bazis project cards of the merged client follow its orders and groups (migration 279: a card, its live orders and its
  // attached XML share one client). Locked after the orders and groups (lock hierarchy of the doweling commands).
  const cards = (await tx.query<{ doweling_order_id: string; client_source: string; version: number }>(
    `UPDATE doweling_orders SET client_id = $2 WHERE client_id = $1
     RETURNING doweling_order_id, client_source, version`, [m, s])).rows
    .map((r) => ({ cardId: Number(r.doweling_order_id), clientSource: r.client_source, version: Number(r.version) }))
    .sort((a, b) => a.cardId - b.cardId);
  for (const card of cards) {
    items.push({ kind: 'bazis_card', rowId: card.cardId, before: { clientId: m, clientSource: card.clientSource },
      after: { clientId: s, version: card.version } });
  }

  const phones = planPhones(state);
  for (const drop of phones.drop) {
    await tx.query('DELETE FROM client_phones WHERE phone_id = $1', [drop.phone.phoneId]);
    items.push({ kind: 'phone_deleted', rowId: drop.phone.phoneId, before: { ...phoneRow(drop.phone), matchedPhoneId: drop.match.phoneId }, after: null });
    if (drop.keyMoves) {
      await tx.query('UPDATE client_phones SET ref_key_1c = $2::uuid WHERE phone_id = $1', [drop.match.phoneId, drop.phone.ref]);
      items.push({ kind: 'phone_key_moved', rowId: drop.match.phoneId, before: { refKey1c: null, fromPhoneId: drop.phone.phoneId }, after: { refKey1c: drop.phone.ref } });
    }
  }
  for (const phone of phones.move) {
    await tx.query('UPDATE client_phones SET client_id = $2, is_primary = false WHERE phone_id = $1', [phone.phoneId, s]);
    items.push({ kind: 'phone_moved', rowId: phone.phoneId, before: phoneRow(phone), after: { ...phoneRow(phone), clientId: s, isPrimary: false } });
  }
  if (phones.primary) {
    await tx.query('UPDATE client_phones SET is_primary = true WHERE phone_id = $1', [phones.primary.phoneId]);
    items.push({ kind: 'phone_primary', rowId: phones.primary.phoneId, before: { isPrimary: false }, after: { isPrimary: true } });
  }

  const contacts = planContacts(state);
  for (const drop of contacts.drop) {
    await tx.query('DELETE FROM client_contacts WHERE contact_id = $1', [drop.contact.contactId]);
    items.push({ kind: 'contact_deleted', rowId: drop.contact.contactId, before: { ...contactRow(drop.contact), matchedContactId: drop.match?.contactId ?? null }, after: null });
  }
  let position = Math.max(-1, ...state.contacts.filter((c) => c.clientId === s).map((c) => c.position));
  for (const contact of contacts.move) {
    position = Math.min(99, position + 1);
    await tx.query('UPDATE client_contacts SET client_id = $2, is_primary = false, position = $3, updated_by = $4, updated_at = now() WHERE contact_id = $1',
      [contact.contactId, s, position, Number(actor.id)]);
    items.push({ kind: 'contact_moved', rowId: contact.contactId, before: contactRow(contact), after: { ...contactRow(contact), clientId: s, isPrimary: false, position } });
  }
  for (const primary of contacts.primary) {
    await tx.query('UPDATE client_contacts SET is_primary = true WHERE contact_id = $1', [primary.contactId]);
    items.push({ kind: 'contact_primary', rowId: primary.contactId, before: { isPrimary: false, kind: primary.kind }, after: { isPrimary: true, kind: primary.kind } });
  }
  await bumpContactVersions(tx, [s, m]);

  if (state.merged.ref) {
    await links.transferLink(tx, { fromClientId: m, toClientId: s, refKey1c: state.merged.ref, actor, requestId: ctx.requestId, via: 'merge', mergeId });
  }

  await tx.query('UPDATE clients SET is_active = false, edited_by = $2 WHERE client_id = $1', [m, Number(actor.id)]);
  const counts: Record<string, number> = {
    projects: state.projects.length, orders: state.orders.length, phonesMoved: phones.move.length, phonesDeleted: phones.drop.length,
    phoneKeysMoved: phones.drop.filter((d) => d.keyMoves).length, phoneKeysLost: phones.drop.filter((d) => d.keyLost).length,
    contactsMoved: contacts.move.length, contactsDeleted: contacts.drop.length, onecLink: state.merged.ref ? 1 : 0, redirectsRepointed: 0,
    bazisCards: cards.length,
  };

  if (state.merged.ref) items.push({ kind: 'onec_link', rowId: m, before: { clientId: m, refKey1c: state.merged.ref }, after: { clientId: s, refKey1c: state.merged.ref } });
  // Chains stay flat: clients merged into the merged client before now point to the survivor.
  const repointed = (await tx.query<{ merged_client_id: string }>(
    'UPDATE client_merge_redirects SET survivor_id = $2 WHERE survivor_id = $1 RETURNING merged_client_id', [m, s])).rows;
  for (const row of repointed) items.push({ kind: 'redirect_repointed', rowId: Number(row.merged_client_id), before: { survivorId: m }, after: { survivorId: s } });
  counts.redirectsRepointed = repointed.length;
  await tx.query('INSERT INTO client_merge_redirects (merged_client_id, survivor_id, merge_id) VALUES ($1, $2, $3)', [m, s, mergeId]);
  await writeItems(tx, mergeId, items);
  await tx.query('UPDATE client_merges SET counts = $2::jsonb WHERE merge_id = $1', [mergeId, JSON.stringify(counts)]);

  await auditMovedOrders(tx, state.orders.map((o) => o.orderId), m, s, mergeId, actor, ctx, 'client_merge');
  await auditMovedCards(tx, cards, m, s, mergeId, actor, ctx, 'client_merge');
  return { mergeId, movedOrderIds: orderIds, counts };
}

export async function bumpContactVersions(tx: TransactionClient, clientIds: number[]): Promise<void> {
  await tx.query(
    `INSERT INTO party_contact_versions (party_kind, party_id, version, updated_at)
     SELECT 'client', id, 1, now() FROM unnest($1::bigint[]) AS id
     ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now()`, [clientIds]);
}

export async function writeItems(tx: TransactionClient, mergeId: number, items: readonly MergeItem[], from = 0): Promise<void> {
  for (let i = 0; i < items.length; i += 200) {
    const part = items.slice(i, i + 200);
    const params: unknown[] = [mergeId];
    const values = part.map((item, j) => {
      params.push(from + i + j + 1, item.kind, String(item.rowId), item.before === null ? null : JSON.stringify(item.before),
        item.after === null ? null : JSON.stringify(item.after));
      const b = params.length - 4;
      return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4}::jsonb)`;
    });
    await tx.query(`INSERT INTO client_merge_items (merge_id, item_no, item_kind, row_id, before, after) VALUES ${values.join(', ')}`, params);
  }
}

/** A normalized audit row for every order whose client changed (old and new client, the merge, the way). */
export async function auditMovedOrders(
  tx: TransactionClient, orderIds: readonly number[], fromClientId: number, toClientId: number, mergeId: number,
  actor: CurrentUser, ctx: MergeContext, via: 'client_merge' | 'client_merge_undo',
): Promise<void> {
  for (const orderId of orderIds) {
    await auditService.record(tx, {
      event: 'order.client_changed', entityType: 'order', entityId: orderId,
      actorUserId: Number(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId: ctx.requestId, source: SOURCE,
      relatedOrderId: orderId, relatedClientId: toClientId,
      relatedEntities: [{ entityType: 'client', entityId: fromClientId }, { entityType: 'client', entityId: toClientId }, { entityType: 'client_merge', entityId: mergeId }],
      before: { clientId: fromClientId }, after: { clientId: toClientId },
      metadata: { via, mergeId, correlationId: ctx.correlationId },
    });
  }
}

/**
 * A normalized audit row and the `doweling_order.updated` event for every Bazis project card whose client changed with
 * a merge or its undo (one event per card and merge direction).
 */
export async function auditMovedCards(
  tx: TransactionClient, cards: ReadonlyArray<{ cardId: number; version: number }>, fromClientId: number, toClientId: number,
  mergeId: number, actor: CurrentUser, ctx: MergeContext, via: 'client_merge' | 'client_merge_undo',
): Promise<void> {
  for (const card of cards) {
    const auditId = await auditService.record(tx, {
      event: 'doweling.updated', entityType: 'doweling_order', entityId: card.cardId,
      actorUserId: Number(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId: ctx.requestId, source: SOURCE,
      relatedClientId: toClientId,
      relatedEntities: [{ entityType: 'doweling_order', entityId: card.cardId }, { entityType: 'client', entityId: fromClientId },
        { entityType: 'client', entityId: toClientId }, { entityType: 'client_merge', entityId: mergeId }],
      before: { clientId: fromClientId }, after: { clientId: toClientId },
      diff: { clientId: { from: fromClientId, to: toClientId } },
      metadata: { action: via, via, mergeId, correlationId: ctx.correlationId, dowelingOrderId: card.cardId },
    });
    const key = `${via}-${mergeId}-card-${card.cardId}`;
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ('doweling_order.updated', 'doweling_order', $1, $2::jsonb, $3) ON CONFLICT (idempotency_key) DO NOTHING`,
      [String(card.cardId), JSON.stringify({
        eventType: 'doweling_order.updated', dowelingOrderId: card.cardId, action: via, changedFields: ['clientId'],
        fromClientId, toClientId, mergeId, version: card.version, auditId, actorUserId: actor.id, requestId: ctx.requestId,
        idempotencyKey: key,
      }), key]);
  }
}
