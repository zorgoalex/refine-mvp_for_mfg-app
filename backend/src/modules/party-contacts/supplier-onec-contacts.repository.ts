import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { OnecCatalogReader, type OnecContactsState } from '../onec-agent/onec-catalog-reader';
import { onecContactValues } from './onec-contact-values';
import { maskPartyContact } from './party-contact-values';
import type { PartyContactKind } from './party-contacts';

const SOURCE = 'erp_party_contacts';
const CONTACTS_ENTITY = 'counterparty_contacts';

export type SyncTrigger = 'published' | 'hourly' | 'manual' | 'link';

/** Who and what started a sync: a user (the button, a link change) or the system (a 1C publication, the hourly pass). */
export interface SyncContext {
  trigger: SyncTrigger;
  requestId: string;
  correlationId: string;
  actor: CurrentUser | null;
}

export type SupplierSyncOutcome =
  | { status: 'changed' | 'unchanged'; added: number; removed: number; updated: number; skipped: number; contactsState: OnecContactsState['status'] }
  | { status: 'skipped'; reason: 'not_found' | 'no_source' | 'not_loaded' | 'mirror_unavailable' };

/** What the card shows of the 1C counterparty of a supplier (the last sync, the 1C data state now). */
export interface SupplierOnecProfile {
  sourceId: number;
  refKey1c: string;
  counterpartyName: string | null;
  /** ИИН/БИН — only while the 1C contacts may be shown. */
  identificationNumber: string | null;
  counterpartyState: 'active' | 'deletion_mark' | 'missing' | 'not_found';
  /** `unavailable` — the last sync saw the data, but it is revoked or expired now (the next sync removes the copy). */
  contactsState: OnecContactsState['status'] | 'unavailable';
  snapshotVersion: string | null;
  skipped: number;
  syncedAt: string;
}

interface OnecRow { contact_id: string; kind: PartyContactKind; value: string; value_normalized: string; origin: 'erp' | 'onec'; onec_source_id: string | null; onec_snapshot_version: Date | null }
interface ProfileRow {
  source_id: string; ref_key_1c: string; counterparty_name: string | null; identification_number: string | null;
  counterparty_state: SupplierOnecProfile['counterpartyState']; contacts_state: OnecContactsState['status'];
  snapshot_version: Date | null; skipped: number; synced_at: Date; available_now: boolean;
}

/**
 * Contacts of the 1C counterparty linked to a supplier (`suppliers.ref_key_1c`) as rows 'onec' of supplier_contacts
 * (plan K4a). Each supplier is synced in its own transaction; lock order as the contacts command and the supplier
 * send: supplier (FOR NO KEY UPDATE) → state of the 1C contacts set (FOR SHARE, held to commit: a revocation waits
 * or is already seen) → version → contacts. The state and the rows of 1C are read in one query of the 1C reader.
 * Idempotent: the same snapshot changes nothing and writes no audit.
 */
@Injectable()
export class SupplierOnecContactsRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnecCatalogReader) private readonly reader: OnecCatalogReader,
  ) {}

  /** Suppliers to look at: linked ones, and ones still holding a copy of 1C (unlinked by an older release). */
  async targets(): Promise<number[]> {
    const rows = (await this.database.query<{ supplier_id: string }>(`SELECT supplier_id FROM suppliers WHERE ref_key_1c IS NOT NULL
      UNION SELECT supplier_id FROM supplier_contacts WHERE origin = 'onec'
      UNION SELECT party_id FROM party_onec_profiles WHERE party_kind = 'supplier' ORDER BY 1`)).rows;
    return rows.map((row) => Number(row.supplier_id));
  }

  async sync(supplierId: number, ctx: SyncContext): Promise<SupplierSyncOutcome> {
    let sources: number[];
    try {
      sources = await this.reader.entitySourceIds(CONTACTS_ENTITY);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return { status: 'skipped', reason: 'mirror_unavailable' };
      throw error;
    }
    return this.database.transaction(async (tx) => {
      await markSync(tx);
      const owner = (await tx.query<{ ref: string | null }>(
        'SELECT lower(ref_key_1c::text) AS ref FROM suppliers WHERE supplier_id = $1 FOR NO KEY UPDATE', [supplierId])).rows[0];
      if (!owner) {
        // A profile left by a supplier deleted before migration 243's trigger: personal data does not outlive its owner.
        await tx.query(`DELETE FROM party_onec_profiles WHERE party_kind = 'supplier' AND party_id = $1`, [supplierId]);
        return { status: 'skipped', reason: 'not_found' } as const;
      }
      const rows = (await tx.query<OnecRow>(`SELECT contact_id, kind, value, value_normalized, origin, onec_source_id, onec_snapshot_version FROM supplier_contacts
        WHERE supplier_id = $1 ORDER BY contact_id`, [supplierId])).rows;
      const copy = rows.filter((row) => row.origin === 'onec');
      const profile = (await tx.query<{ source_id: string; ref_key_1c: string; snapshot_version: Date | null }>(
        `SELECT source_id, lower(ref_key_1c::text) AS ref_key_1c, snapshot_version FROM party_onec_profiles WHERE party_kind = 'supplier' AND party_id = $1`,
        [supplierId])).rows[0];

      if (owner.ref === null) {
        if (!copy.length && !profile) return unchanged('not_loaded');
        await this.removeCopy(tx, supplierId, copy, profile ? Number(profile.source_id) : null, profile?.ref_key_1c ?? null, 'unlinked', ctx);
        return copy.length
          ? { status: 'changed', added: 0, removed: copy.length, updated: 0, skipped: 0, contactsState: 'not_loaded' } as const
          : unchanged('not_loaded');
      }

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
      const keepProfile = (skipped: number) => this.upsertProfile(tx, supplierId, sourceId as number, owner.ref as string, counterparty?.name ?? null,
        state.status === 'available' ? counterparty?.identificationNumber ?? null : null, counterpartyState, state, skipped);

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
        if (copy.length) await this.removeCopy(tx, supplierId, copy, sourceId, owner.ref, state.status, ctx);
        await keepProfile(0);
        return copy.length
          ? { status: 'changed', added: 0, removed: copy.length, updated: 0, skipped: 0, contactsState: state.status } as const
          : unchanged(state.status);
      }

      const desired = onecContactValues(contacts);
      const wanted = new Map(desired.values.map((value) => [`${value.kind}:${value.valueNormalized}`, value]));
      const own = new Set(rows.filter((row) => row.origin === 'erp').map((row) => `${row.kind}:${row.value_normalized}`));
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
        await tx.query('DELETE FROM supplier_contacts WHERE contact_id = ANY($1::bigint[])', [removedRows.map((row) => row.contact_id)]);
      }
      for (const row of updatedRows) {
        await tx.query(`UPDATE supplier_contacts SET value = $2, onec_snapshot_version = $3::timestamptz, onec_synced_at = now(), updated_at = now()
          WHERE contact_id = $1`, [row.contact_id, row.value, state.snapshotVersion]);
      }
      if (restamped.length) {
        await tx.query('UPDATE supplier_contacts SET onec_snapshot_version = $2::timestamptz, onec_synced_at = now() WHERE contact_id = ANY($1::bigint[])',
          [restamped, state.snapshotVersion]);
      }
      for (const value of added) {
        await tx.query(`INSERT INTO supplier_contacts (supplier_id, kind, value, value_normalized, is_primary, position, origin, onec_source_id,
            onec_snapshot_version, onec_synced_at)
          VALUES ($1, $2, $3, $4, FALSE, 99, 'onec', $5, $6::timestamptz, now())`, [supplierId, value.kind, value.value, value.valueNormalized, sourceId, state.snapshotVersion]);
      }
      await keepProfile(desired.skipped);
      const changed = removedRows.length + updatedRows.length + added.length > 0;
      if (changed) {
        await bumpVersion(tx, supplierId);
        const auditId = await this.audit(tx, 'supplier.contacts.onec_synced', supplierId, sourceId, owner.ref, state, ctx, {
          added: added.map((value) => mask(value.kind, value.valueNormalized)),
          removed: removedRows.map((row) => mask(row.kind, row.value_normalized)),
          updated: updatedRows.map((row) => mask(row.kind, row.value_normalized)),
          skipped: desired.skipped,
        });
        await outbox(tx, 'party_contacts.onec_synced', supplierId, sourceId, owner.ref, auditId, ctx,
          { added: added.length, removed: removedRows.length, updated: updatedRows.length, snapshotVersion: state.snapshotVersion });
      }
      return {
        status: changed ? 'changed' : 'unchanged', added: added.length, removed: removedRows.length, updated: updatedRows.length,
        skipped: desired.skipped, contactsState: state.status,
      } as const;
    });
  }

  /** The outcome of a whole pass (diagnostics). */
  async recordPass(trigger: SyncTrigger, startedAt: Date, counts: { processed: number; changed: number; failed: number }, lastError: string | null): Promise<void> {
    await this.database.query(`INSERT INTO party_onec_sync_state (party_kind, trigger, started_at, finished_at, processed, changed, failed, last_error)
      VALUES ('supplier', $1, $2, now(), $3, $4, $5, $6)
      ON CONFLICT (party_kind) DO UPDATE SET trigger = EXCLUDED.trigger, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
        processed = EXCLUDED.processed, changed = EXCLUDED.changed, failed = EXCLUDED.failed, last_error = EXCLUDED.last_error`,
    [trigger, startedAt, counts.processed, counts.changed, counts.failed, lastError]);
  }

  private async removeCopy(tx: TransactionClient, supplierId: number, copy: readonly OnecRow[], sourceId: number | null, refKey1c: string | null,
    reason: 'unlinked' | 'revoked' | 'expired', ctx: SyncContext): Promise<void> {
    if (copy.length) await tx.query('DELETE FROM supplier_contacts WHERE contact_id = ANY($1::bigint[])', [copy.map((row) => row.contact_id)]);
    if (reason === 'unlinked') await tx.query(`DELETE FROM party_onec_profiles WHERE party_kind = 'supplier' AND party_id = $1`, [supplierId]);
    if (!copy.length) return;
    await bumpVersion(tx, supplierId);
    const auditId = await this.audit(tx, 'supplier.contacts.onec_removed', supplierId, sourceId, refKey1c, null, ctx, {
      reason, removed: copy.map((row) => mask(row.kind, row.value_normalized)),
    });
    await outbox(tx, 'party_contacts.onec_removed', supplierId, sourceId, refKey1c, auditId, ctx, { reason, removed: copy.length });
  }

  private upsertProfile(tx: TransactionClient, supplierId: number, sourceId: number, refKey1c: string, name: string | null, identificationNumber: string | null,
    counterpartyState: SupplierOnecProfile['counterpartyState'], state: OnecContactsState, skipped: number) {
    return tx.query(`INSERT INTO party_onec_profiles (party_kind, party_id, source_id, ref_key_1c, counterparty_name, identification_number,
        counterparty_state, contacts_state, snapshot_version, skipped, synced_at)
      VALUES ('supplier', $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (party_kind, party_id) DO UPDATE SET source_id = EXCLUDED.source_id, ref_key_1c = EXCLUDED.ref_key_1c,
        counterparty_name = EXCLUDED.counterparty_name, identification_number = EXCLUDED.identification_number,
        counterparty_state = EXCLUDED.counterparty_state, contacts_state = EXCLUDED.contacts_state,
        snapshot_version = EXCLUDED.snapshot_version, skipped = EXCLUDED.skipped, synced_at = EXCLUDED.synced_at`,
    [supplierId, sourceId, refKey1c, name, identificationNumber, counterpartyState, state.status, state.snapshotVersion, skipped]);
  }

  private audit(tx: TransactionClient, event: string, supplierId: number, sourceId: number | null, refKey1c: string | null,
    state: OnecContactsState | null, ctx: SyncContext, metadata: Record<string, unknown>): Promise<string> {
    return auditService.record(tx, {
      event, entityType: 'supplier', entityId: supplierId,
      actorUserId: ctx.actor ? Number(ctx.actor.id) : null, actorUsername: ctx.actor?.username ?? null, actorRole: ctx.actor?.role ?? null,
      requestId: ctx.requestId, source: SOURCE,
      relatedEntities: [{ entityType: 'supplier', entityId: supplierId }],
      metadata: {
        ...metadata, trigger: ctx.trigger, correlationId: ctx.correlationId, sourceId, refKey1c,
        snapshotVersion: state?.snapshotVersion ?? null, contactsState: state?.status ?? null,
      },
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
  if (removed) await bumpVersion(tx, supplierId);
  return removed;
}

/** What the card shows of the 1C counterparty of a supplier; ИИН/БИН only while the 1C contacts may be shown right now. */
export async function readSupplierOnecProfile(client: DatabaseClient, supplierId: number): Promise<SupplierOnecProfile | null> {
  const row = (await client.query<ProfileRow>(`SELECT source_id, lower(ref_key_1c::text) AS ref_key_1c, counterparty_name, identification_number,
      counterparty_state, contacts_state, snapshot_version, skipped, synced_at, party_onec_contacts_available(source_id, snapshot_version) AS available_now
     FROM party_onec_profiles WHERE party_kind = 'supplier' AND party_id = $1`, [supplierId])).rows[0];
  if (!row) return null;
  const visible = row.contacts_state === 'available' && row.available_now;
  return {
    sourceId: Number(row.source_id), refKey1c: row.ref_key_1c, counterpartyName: row.counterparty_name,
    identificationNumber: visible ? row.identification_number : null, counterpartyState: row.counterparty_state,
    contactsState: row.contacts_state === 'available' && !row.available_now ? 'unavailable' : row.contacts_state,
    snapshotVersion: row.snapshot_version ? row.snapshot_version.toISOString() : null, skipped: row.skipped, syncedAt: row.synced_at.toISOString(),
  };
}

const mask = (kind: PartyContactKind, normalized: string) => ({ kind, masked: maskPartyContact(kind, normalized) });

const unchanged = (contactsState: OnecContactsState['status']): SupplierSyncOutcome =>
  ({ status: 'unchanged', added: 0, removed: 0, updated: 0, skipped: 0, contactsState });

/** The version write of this transaction keeps «saved by the command» as it was (migration 243). */
async function markSync(tx: TransactionClient): Promise<void> {
  await tx.query(`SELECT set_config('erp.party_contacts_onec_sync', 'on', true)`);
}

/** An open editor of the set gets a version conflict and re-reads. */
async function bumpVersion(tx: TransactionClient, supplierId: number): Promise<void> {
  await tx.query(`INSERT INTO party_contact_versions (party_kind, party_id, version) VALUES ('supplier', $1, 1)
    ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now()`, [supplierId]);
}

/** The domain event of the transition, in the same transaction; the audit row id makes the key of this very transition. */
async function outbox(tx: TransactionClient, eventType: string, supplierId: number, sourceId: number | null, refKey1c: string | null, auditId: string,
  ctx: SyncContext, details: Record<string, unknown>): Promise<void> {
  await tx.query(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, 'supplier', $2, $3::jsonb, $4) ON CONFLICT DO NOTHING`, [
    eventType, String(supplierId), JSON.stringify({
      eventId: randomUUID(), eventType, supplierId, sourceId, refKey1c, auditId, ...details,
      actorUserId: ctx.actor ? Number(ctx.actor.id) : null, trigger: ctx.trigger, requestId: ctx.requestId, correlationId: ctx.correlationId, source: SOURCE,
    }), `${eventType}:${sourceId ?? 0}:supplier:${supplierId}:${auditId}`,
  ]);
}
