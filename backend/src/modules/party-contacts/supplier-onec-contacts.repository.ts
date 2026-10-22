import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { OnecCatalogReader, type OnecContactsState } from '../onec-agent/onec-catalog-reader';
import { onecContactValues } from './onec-contact-values';
import { maskPartyContact, normalizePartyContact } from './party-contact-values';
import type { PartyContactKind } from './party-contacts';

const SOURCE = 'erp_party_contacts';
const CONTACTS_ENTITY = 'counterparty_contacts';

export type SyncTrigger = 'published' | 'hourly' | 'manual' | 'link';

/** Owners whose contacts come from the linked 1C counterparty: suppliers (K4a), clients (K4b). */
export type OnecOwner = 'supplier' | 'client';
/** Why the copy of an owner went away (the audit and the event say it). */
export type OnecRemovalReason = 'unlinked' | 'relinked' | 'revoked' | 'expired' | 'merged' | 'merge_transfer';

const OWNERS: Record<OnecOwner, { table: string; id: string; ownerTable: string }> = {
  supplier: { table: 'supplier_contacts', id: 'supplier_id', ownerTable: 'suppliers' },
  client: { table: 'client_contacts', id: 'client_id', ownerTable: 'clients' },
};

/** Who and what started a sync: a user (the button, a link change) or the system (a 1C publication, the hourly pass). */
export interface SyncContext {
  trigger: SyncTrigger;
  requestId: string;
  correlationId: string;
  actor: CurrentUser | null;
}

export type OnecSyncOutcome =
  | { status: 'changed' | 'unchanged'; added: number; removed: number; updated: number; skipped: number; contactsState: OnecContactsState['status'] }
  | { status: 'skipped'; reason: 'not_found' | 'no_source' | 'not_loaded' | 'mirror_unavailable' };
/** The K4a name of the same outcome. */
export type SupplierSyncOutcome = OnecSyncOutcome;

/** What the card shows of the 1C counterparty of an owner (the last sync, the 1C data state now). */
export interface SupplierOnecProfile {
  sourceId: number;
  refKey1c: string;
  /** Suppliers only: a client's block «Контрагент 1С» reads the name and ИИН/БИН from the 1C data itself. */
  counterpartyName: string | null;
  /** ИИН/БИН — suppliers only, and only while the 1C contacts may be shown. */
  identificationNumber: string | null;
  counterpartyState: 'active' | 'deletion_mark' | 'missing' | 'not_found';
  /** `unavailable` — the last sync saw the data, but it is revoked or expired now (the next sync removes the copy). */
  contactsState: OnecContactsState['status'] | 'unavailable';
  snapshotVersion: string | null;
  skipped: number;
  syncedAt: string;
}
export type OnecProfile = SupplierOnecProfile;

interface OnecRow { contact_id: string; kind: PartyContactKind; value: string; value_normalized: string; origin: 'erp' | 'onec'; onec_source_id: string | null; onec_snapshot_version: Date | null }
interface ProfileRow {
  source_id: string; ref_key_1c: string; counterparty_name: string | null; identification_number: string | null;
  counterparty_state: SupplierOnecProfile['counterpartyState']; contacts_state: OnecContactsState['status'];
  snapshot_version: Date | null; skipped: number; synced_at: Date; available_now: boolean;
}

/**
 * Contacts of the 1C counterparty linked to a supplier or a client (`ref_key_1c` of the owner) as rows 'onec' of its
 * contacts table (plans K4a, K4b). Each owner is synced in its own transaction; lock order as the contacts command and
 * the sends: owner (FOR NO KEY UPDATE) → state of the 1C contacts set (FOR SHARE, held to commit: a revocation waits or
 * is already seen) → version → contacts. The state and the rows of 1C are read in one query of the 1C reader.
 * Idempotent: the same snapshot changes nothing and writes no audit.
 * A client's own values are its phones (client_phones) and its rows 'erp'; a merged client (migration 268) gets no copy.
 */
@Injectable()
export class SupplierOnecContactsRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnecCatalogReader) private readonly reader: OnecCatalogReader,
  ) {}

  /** Owners to look at: linked ones, and ones still holding a copy of 1C or a profile (unlinked meanwhile). */
  async targets(party: OnecOwner = 'supplier'): Promise<number[]> {
    const o = OWNERS[party];
    const rows = (await this.database.query<{ id: string }>(`SELECT ${o.id} AS id FROM ${o.ownerTable} WHERE ref_key_1c IS NOT NULL
      UNION SELECT ${o.id} FROM ${o.table} WHERE origin = 'onec'
      UNION SELECT party_id FROM party_onec_profiles WHERE party_kind = $1 ORDER BY 1`, [party])).rows;
    return rows.map((row) => Number(row.id));
  }

  /** K4a: one supplier. */
  sync(supplierId: number, ctx: SyncContext): Promise<OnecSyncOutcome> {
    return this.syncOwner('supplier', supplierId, ctx);
  }

  /** K4b: one client. */
  syncClient(clientId: number, ctx: SyncContext): Promise<OnecSyncOutcome> {
    return this.syncOwner('client', clientId, ctx);
  }

  async syncOwner(party: OnecOwner, ownerId: number, ctx: SyncContext): Promise<OnecSyncOutcome> {
    const o = OWNERS[party];
    let sources: number[];
    try {
      sources = await this.reader.entitySourceIds(CONTACTS_ENTITY);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return { status: 'skipped', reason: 'mirror_unavailable' };
      throw error;
    }
    const mergeAware = party === 'client' && await this.hasMergeRedirects();
    return this.database.transaction(async (tx) => {
      await markSync(tx);
      const owner = (await tx.query<{ ref: string | null; merged: boolean }>(
        `SELECT lower(x.ref_key_1c::text) AS ref,
                ${mergeAware ? 'EXISTS (SELECT 1 FROM client_merge_redirects r WHERE r.merged_client_id = x.client_id)' : 'FALSE'} AS merged
           FROM ${o.ownerTable} x WHERE x.${o.id} = $1 FOR NO KEY UPDATE OF x`, [ownerId])).rows[0];
      if (!owner) {
        // A profile left by an owner deleted meanwhile: personal data does not outlive its owner.
        await tx.query('DELETE FROM party_onec_profiles WHERE party_kind = $1 AND party_id = $2', [party, ownerId]);
        return { status: 'skipped', reason: 'not_found' } as const;
      }
      const rows = (await tx.query<OnecRow>(`SELECT contact_id, kind, value, value_normalized, origin, onec_source_id, onec_snapshot_version FROM ${o.table}
        WHERE ${o.id} = $1 ORDER BY contact_id`, [ownerId])).rows;
      let copy = rows.filter((row) => row.origin === 'onec');
      let profile: { source_id: string; ref_key_1c: string; snapshot_version: Date | null } | undefined = (await tx.query<{ source_id: string; ref_key_1c: string; snapshot_version: Date | null }>(
        'SELECT source_id, lower(ref_key_1c::text) AS ref_key_1c, snapshot_version FROM party_onec_profiles WHERE party_kind = $1 AND party_id = $2',
        [party, ownerId])).rows[0];
      const removedAll = (state: OnecContactsState['status']): OnecSyncOutcome =>
        ({ status: 'changed', added: 0, removed: copy.length, updated: 0, skipped: 0, contactsState: state });

      // No link (or a merged client: its link went to the survivor) — the copy and the profile go.
      if (owner.ref === null || owner.merged) {
        if (!copy.length && !profile) return unchanged('not_loaded');
        await this.removeCopy(tx, party, ownerId, copy, profile ? Number(profile.source_id) : null, profile?.ref_key_1c ?? null,
          owner.merged ? 'merged' : 'unlinked', ctx, true);
        return copy.length ? removedAll('not_loaded') : unchanged('not_loaded');
      }
      // The link changed past the link command (an older release, a direct write): the copy of the previous counterparty goes first.
      let relinked = 0;
      if (profile && profile.ref_key_1c !== owner.ref) {
        await this.removeCopy(tx, party, ownerId, copy, Number(profile.source_id), profile.ref_key_1c, 'relinked', ctx, true);
        relinked = copy.length;
        copy = [];
        profile = undefined;
      }
      const withRelinked = (outcome: OnecSyncOutcome): OnecSyncOutcome => (relinked && outcome.status !== 'skipped'
        ? { ...outcome, status: 'changed', removed: outcome.removed + relinked } : outcome);

      // The source of the counterparty: the one that has it; else the only one; else the one of the last sync.
      let sourceId: number | null = null;
      let counterparty: Awaited<ReturnType<OnecCatalogReader['listCounterparties']>>[number] | null = null;
      for (const candidate of sources) {
        const found = await this.reader.listCounterparties(candidate, [owner.ref], tx);
        if (found.length) { sourceId = candidate; counterparty = found[0]; break; }
      }
      if (sourceId === null) {
        sourceId = sources.length === 1 ? sources[0] : profile && sources.includes(Number(profile.source_id)) ? Number(profile.source_id) : null;
      }
      if (sourceId === null) return { status: 'skipped', reason: 'no_source' } as const;

      await this.reader.lockEntityShare(tx, sourceId, CONTACTS_ENTITY);
      const { state, contacts } = await this.reader.counterpartyContacts(sourceId, [owner.ref], tx);
      const counterpartyState: SupplierOnecProfile['counterpartyState'] = !counterparty ? 'not_found'
        : counterparty.missing ? 'missing' : counterparty.deletionMark ? 'deletion_mark' : 'active';
      // A client's name and ИИН/БИН are read from the 1C data by its block «Контрагент 1С»: not copied.
      const keepProfile = (skipped: number) => this.upsertProfile(tx, party, ownerId, sourceId as number, owner.ref as string,
        party === 'supplier' ? counterparty?.name ?? null : null,
        party === 'supplier' && state.status === 'available' ? counterparty?.identificationNumber ?? null : null, counterpartyState, state, skipped);

      // «Not loaded» is not «no contacts»: nothing of the copy changes.
      if (state.status === 'not_loaded') {
        await keepProfile(0);
        return { status: 'skipped', reason: 'not_loaded' } as const;
      }
      // An older snapshot of the same counterparty never overwrites a newer one.
      if (profile && Number(profile.source_id) === sourceId && profile.ref_key_1c === owner.ref && profile.snapshot_version && state.snapshotVersion
        && profile.snapshot_version.getTime() > Date.parse(state.snapshotVersion)) {
        return unchanged(state.status);
      }
      if (state.status !== 'available') {
        if (copy.length) await this.removeCopy(tx, party, ownerId, copy, sourceId, owner.ref, state.status, ctx, false);
        await keepProfile(0);
        return withRelinked(copy.length ? removedAll(state.status) : unchanged(state.status));
      }

      const desired = onecContactValues(contacts);
      const wanted = new Map(desired.values.map((value) => [`${value.kind}:${value.valueNormalized}`, value]));
      const own = new Set(rows.filter((row) => row.origin === 'erp').map((row) => `${row.kind}:${row.value_normalized}`));
      if (party === 'client') for (const number of await clientPhoneNumbers(tx, ownerId)) own.add(`phone:${number}`);
      const kept = new Set<string>();
      const removedRows: OnecRow[] = [];
      const updatedRows: OnecRow[] = [];
      const restamped: string[] = [];
      const snapshotMs = Date.parse(state.snapshotVersion as string);
      for (const row of copy) {
        const key = `${row.kind}:${row.value_normalized}`;
        const value = wanted.get(key);
        // A row of another source or a value that is gone — or now typed in by the user — leaves the copy.
        if (!value || Number(row.onec_source_id) !== sourceId || own.has(key) || kept.has(key)) { removedRows.push(row); continue; }
        kept.add(key);
        if (value.value !== row.value) updatedRows.push({ ...row, value: value.value });
        // Reconciled with the current snapshot: the row may be shown again (migration 243 binds a copy to its snapshot).
        else if (row.onec_snapshot_version?.getTime() !== snapshotMs) restamped.push(row.contact_id);
      }
      const added = desired.values.filter((value) => !kept.has(`${value.kind}:${value.valueNormalized}`) && !own.has(`${value.kind}:${value.valueNormalized}`));
      if (removedRows.length) {
        await tx.query(`DELETE FROM ${o.table} WHERE contact_id = ANY($1::bigint[])`, [removedRows.map((row) => row.contact_id)]);
      }
      for (const row of updatedRows) {
        await tx.query(`UPDATE ${o.table} SET value = $2, onec_snapshot_version = $3::timestamptz, onec_synced_at = now(), updated_at = now()
          WHERE contact_id = $1`, [row.contact_id, row.value, state.snapshotVersion]);
      }
      if (restamped.length) {
        await tx.query(`UPDATE ${o.table} SET onec_snapshot_version = $2::timestamptz, onec_synced_at = now() WHERE contact_id = ANY($1::bigint[])`,
          [restamped, state.snapshotVersion]);
      }
      for (const value of added) {
        await tx.query(`INSERT INTO ${o.table} (${o.id}, kind, value, value_normalized, is_primary, position, origin, onec_source_id,
            onec_snapshot_version, onec_synced_at)
          VALUES ($1, $2, $3, $4, FALSE, 99, 'onec', $5, $6::timestamptz, now())`, [ownerId, value.kind, value.value, value.valueNormalized, sourceId, state.snapshotVersion]);
      }
      await keepProfile(desired.skipped);
      const changed = removedRows.length + updatedRows.length + added.length > 0;
      if (changed) {
        await bumpVersion(tx, party, ownerId);
        const auditId = await this.audit(tx, `${party}.contacts.onec_synced`, party, ownerId, sourceId, owner.ref, state, ctx, {
          added: added.map((value) => mask(value.kind, value.valueNormalized)),
          removed: removedRows.map((row) => mask(row.kind, row.value_normalized)),
          updated: updatedRows.map((row) => mask(row.kind, row.value_normalized)),
          skipped: desired.skipped,
        });
        await outbox(tx, 'party_contacts.onec_synced', party, ownerId, sourceId, owner.ref, auditId, ctx,
          { added: added.length, removed: removedRows.length, updated: updatedRows.length, snapshotVersion: state.snapshotVersion });
      }
      return withRelinked({
        status: changed ? 'changed' : 'unchanged', added: added.length, removed: removedRows.length, updated: updatedRows.length,
        skipped: desired.skipped, contactsState: state.status,
      });
    });
  }

  /** The outcome of a whole pass (diagnostics). */
  async recordPass(trigger: SyncTrigger, startedAt: Date, counts: { processed: number; changed: number; failed: number }, lastError: string | null,
    party: OnecOwner = 'supplier'): Promise<void> {
    await this.database.query(`INSERT INTO party_onec_sync_state (party_kind, trigger, started_at, finished_at, processed, changed, failed, last_error)
      VALUES ($7, $1, $2, now(), $3, $4, $5, $6)
      ON CONFLICT (party_kind) DO UPDATE SET trigger = EXCLUDED.trigger, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
        processed = EXCLUDED.processed, changed = EXCLUDED.changed, failed = EXCLUDED.failed, last_error = EXCLUDED.last_error`,
    [trigger, startedAt, counts.processed, counts.changed, counts.failed, lastError, party]);
  }

  private async hasMergeRedirects(): Promise<boolean> {
    return (await this.database.query<{ ok: boolean }>(`SELECT to_regclass('client_merge_redirects') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  }

  private async removeCopy(tx: TransactionClient, party: OnecOwner, ownerId: number, copy: readonly OnecRow[], sourceId: number | null,
    refKey1c: string | null, reason: OnecRemovalReason, ctx: SyncContext, dropProfile: boolean): Promise<void> {
    if (copy.length) await tx.query(`DELETE FROM ${OWNERS[party].table} WHERE contact_id = ANY($1::bigint[])`, [copy.map((row) => row.contact_id)]);
    if (dropProfile) await tx.query('DELETE FROM party_onec_profiles WHERE party_kind = $1 AND party_id = $2', [party, ownerId]);
    if (!copy.length) return;
    await bumpVersion(tx, party, ownerId);
    const auditId = await this.audit(tx, `${party}.contacts.onec_removed`, party, ownerId, sourceId, refKey1c, null, ctx, {
      reason, removed: copy.map((row) => mask(row.kind, row.value_normalized)),
    });
    await outbox(tx, 'party_contacts.onec_removed', party, ownerId, sourceId, refKey1c, auditId, ctx, { reason, removed: copy.length });
  }

  private upsertProfile(tx: TransactionClient, party: OnecOwner, ownerId: number, sourceId: number, refKey1c: string, name: string | null,
    identificationNumber: string | null, counterpartyState: SupplierOnecProfile['counterpartyState'], state: OnecContactsState, skipped: number) {
    return tx.query(`INSERT INTO party_onec_profiles (party_kind, party_id, source_id, ref_key_1c, counterparty_name, identification_number,
        counterparty_state, contacts_state, snapshot_version, skipped, synced_at)
      VALUES ($10, $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (party_kind, party_id) DO UPDATE SET source_id = EXCLUDED.source_id, ref_key_1c = EXCLUDED.ref_key_1c,
        counterparty_name = EXCLUDED.counterparty_name, identification_number = EXCLUDED.identification_number,
        counterparty_state = EXCLUDED.counterparty_state, contacts_state = EXCLUDED.contacts_state,
        snapshot_version = EXCLUDED.snapshot_version, skipped = EXCLUDED.skipped, synced_at = EXCLUDED.synced_at`,
    [ownerId, sourceId, refKey1c, name, identificationNumber, counterpartyState, state.status, state.snapshotVersion, skipped, party]);
  }

  private audit(tx: TransactionClient, event: string, party: OnecOwner, ownerId: number, sourceId: number | null, refKey1c: string | null,
    state: OnecContactsState | null, ctx: SyncContext, metadata: Record<string, unknown>): Promise<string> {
    return auditOnec(tx, event, party, ownerId, ctx.actor, ctx.requestId, {
      ...metadata, trigger: ctx.trigger, correlationId: ctx.correlationId, sourceId, refKey1c,
      snapshotVersion: state?.snapshotVersion ?? null, contactsState: state?.status ?? null,
    });
  }
}

/**
 * In the link command's transaction (supplier already locked): a new or removed link drops the copy of the previous
 * counterparty and its profile; the values of the new one come with the next sync. Returns how many rows went.
 */
export async function dropSupplierOnecCopy(tx: TransactionClient, supplierId: number): Promise<number> {
  await markSync(tx);
  const removed = (await tx.query("DELETE FROM supplier_contacts WHERE supplier_id = $1 AND origin = 'onec'", [supplierId])).rowCount ?? 0;
  await tx.query(`DELETE FROM party_onec_profiles WHERE party_kind = 'supplier' AND party_id = $1`, [supplierId]);
  if (removed) await bumpVersion(tx, 'supplier', supplierId);
  return removed;
}

/** The link command of a client that removed its copy of 1C: who, why, and the way of the command. */
export interface ClientCopyDrop {
  actor: CurrentUser;
  requestId: string;
  reason: 'unlinked' | 'relinked' | 'merge_transfer';
  /** The way of the link command (`card`, `bulk_confirm`, `merge`, `merge_undo`). */
  via: string;
}

/**
 * K4b, in the link command's transaction (the client row already locked by it; nothing of 1C is locked here): the copy of
 * the previous counterparty and the profile go, the set version moves, and — when anything went — the removal is audited
 * and announced in the same transaction (the sync finds nothing to remove later). Returns how many rows went.
 */
export async function dropClientOnecCopy(tx: TransactionClient, clientId: number, drop: ClientCopyDrop): Promise<number> {
  await markSync(tx);
  const profile = (await tx.query<{ source_id: string; ref: string }>(
    `DELETE FROM party_onec_profiles WHERE party_kind = 'client' AND party_id = $1 RETURNING source_id, lower(ref_key_1c::text) AS ref`, [clientId])).rows[0];
  const rows = (await tx.query<{ kind: PartyContactKind; value_normalized: string; onec_source_id: string }>(
    `DELETE FROM client_contacts WHERE client_id = $1 AND origin = 'onec' RETURNING kind, value_normalized, onec_source_id`, [clientId])).rows;
  if (!rows.length && !profile) return 0;
  if (rows.length) await bumpVersion(tx, 'client', clientId);
  const sourceId = profile ? Number(profile.source_id) : rows.length ? Number(rows[0].onec_source_id) : null;
  const refKey1c = profile?.ref ?? null;
  const ctx: SyncContext = { trigger: 'link', requestId: drop.requestId, correlationId: drop.requestId, actor: drop.actor };
  const auditId = await auditOnec(tx, 'client.contacts.onec_removed', 'client', clientId, drop.actor, drop.requestId, {
    reason: drop.reason, via: drop.via, removed: rows.map((row) => mask(row.kind, row.value_normalized)),
    trigger: 'link', correlationId: drop.requestId, sourceId, refKey1c, snapshotVersion: null, contactsState: null,
  });
  await outbox(tx, 'party_contacts.onec_removed', 'client', clientId, sourceId, refKey1c, auditId, ctx, { reason: drop.reason, via: drop.via, removed: rows.length });
  return rows.length;
}

/** What the card shows of the 1C counterparty of a supplier; ИИН/БИН only while the 1C contacts may be shown right now. */
export function readSupplierOnecProfile(client: DatabaseClient, supplierId: number): Promise<SupplierOnecProfile | null> {
  return readOnecProfile(client, 'supplier', supplierId);
}

/** The state of the 1C copy of an owner (a client: only the profile of its current link). */
export async function readOnecProfile(client: DatabaseClient, party: OnecOwner, ownerId: number): Promise<OnecProfile | null> {
  const o = OWNERS[party];
  const row = (await client.query<ProfileRow & { ref_now: string | null }>(`SELECT p.source_id, lower(p.ref_key_1c::text) AS ref_key_1c, p.counterparty_name,
      p.identification_number, p.counterparty_state, p.contacts_state, p.snapshot_version, p.skipped, p.synced_at,
      party_onec_contacts_available(p.source_id, p.snapshot_version) AS available_now, lower(x.ref_key_1c::text) AS ref_now
     FROM party_onec_profiles p LEFT JOIN ${o.ownerTable} x ON x.${o.id} = p.party_id
    WHERE p.party_kind = $1 AND p.party_id = $2`, [party, ownerId])).rows[0];
  if (!row || (party === 'client' && row.ref_now !== row.ref_key_1c)) return null;
  const visible = row.contacts_state === 'available' && row.available_now;
  return {
    sourceId: Number(row.source_id), refKey1c: row.ref_key_1c, counterpartyName: row.counterparty_name,
    identificationNumber: visible ? row.identification_number : null, counterpartyState: row.counterparty_state,
    contactsState: row.contacts_state === 'available' && !row.available_now ? 'unavailable' : row.contacts_state,
    snapshotVersion: row.snapshot_version ? row.snapshot_version.toISOString() : null, skipped: row.skipped, syncedAt: row.synced_at.toISOString(),
  };
}

const mask = (kind: PartyContactKind, normalized: string) => ({ kind, masked: maskPartyContact(kind, normalized) });

const unchanged = (contactsState: OnecContactsState['status']): OnecSyncOutcome =>
  ({ status: 'unchanged', added: 0, removed: 0, updated: 0, skipped: 0, contactsState });

/** The client's own phone numbers (client_phones) by the rule the 1C phones are normalized with; an unreadable one is no number. */
async function clientPhoneNumbers(tx: TransactionClient, clientId: number): Promise<string[]> {
  const numbers: string[] = [];
  for (const row of (await tx.query<{ phone_number: string }>('SELECT phone_number FROM client_phones WHERE client_id = $1', [clientId])).rows) {
    try {
      numbers.push(normalizePartyContact('phone', row.phone_number));
    } catch {
      // Not a number a copy of 1C could equal.
    }
  }
  return numbers;
}

/** The version write of this transaction keeps «saved by the command» as it was (migration 243). */
async function markSync(tx: TransactionClient): Promise<void> {
  await tx.query(`SELECT set_config('erp.party_contacts_onec_sync', 'on', true)`);
}

/** An open editor of the set gets a version conflict and re-reads. */
async function bumpVersion(tx: TransactionClient, party: OnecOwner, ownerId: number): Promise<void> {
  await tx.query(`INSERT INTO party_contact_versions (party_kind, party_id, version) VALUES ($1, $2, 1)
    ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now()`, [party, ownerId]);
}

function auditOnec(tx: TransactionClient, event: string, party: OnecOwner, ownerId: number, actor: CurrentUser | null, requestId: string,
  metadata: Record<string, unknown>): Promise<string> {
  return auditService.record(tx, {
    event, entityType: party, entityId: ownerId,
    actorUserId: actor ? Number(actor.id) : null, actorUsername: actor?.username ?? null, actorRole: actor?.role ?? null,
    requestId, source: SOURCE,
    ...(party === 'client' ? { relatedClientId: ownerId } : {}),
    relatedEntities: [{ entityType: party, entityId: ownerId }],
    metadata,
  });
}

/** The domain event of the transition, in the same transaction; the audit row id makes the key of this very transition. */
async function outbox(tx: TransactionClient, eventType: string, party: OnecOwner, ownerId: number, sourceId: number | null, refKey1c: string | null,
  auditId: string, ctx: SyncContext, details: Record<string, unknown>): Promise<void> {
  await tx.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING`, [
    eventType, party, String(ownerId), JSON.stringify({
      eventId: randomUUID(), eventType, [`${party}Id`]: ownerId, sourceId, refKey1c, auditId, ...details,
      actorUserId: ctx.actor ? Number(ctx.actor.id) : null, trigger: ctx.trigger, requestId: ctx.requestId, correlationId: ctx.correlationId, source: SOURCE,
    }), `${eventType}:${sourceId ?? 0}:${party}:${ownerId}:${auditId}`,
  ]);
}
