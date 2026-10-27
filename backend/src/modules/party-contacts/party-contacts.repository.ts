import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { maskPartyContact, planContactSet, type StoredContact } from './party-contact-values';
import {
  PARTY_CONFIG, PARTY_CONTACT_CODES, PARTY_CONTACTS_VERSION_CONFLICT,
  type PartyConfig, type PartyContact, type PartyContactInput, type PartyContactKind, type PartyContactOrigin, type PartyContacts, type PartyKind,
} from './party-contacts';

const SOURCE = 'erp_party_contacts';

interface ContactRow extends QueryResultRow {
  contact_id: string; owner_id: string; kind: PartyContactKind; value: string; value_normalized: string; is_primary: boolean;
  note: string | null; position: number; created_by: string | null; created_at: Date; origin: PartyContactOrigin; available: boolean;
}

/**
 * A row of 1C is shown and used only while it matches the snapshot its source holds now and that snapshot may be used
 * (party_onec_contacts_available, migration 243): a revocation, a new snapshot or the expiry of the 1C contacts hides it at
 * once, until the sync reconciles it.
 */
const ROW_COLUMNS = (owner: string) => `c.*, c.${owner} AS owner_id, party_onec_contacts_available(c.onec_source_id, c.onec_snapshot_version) AS available`;

/**
 * Contacts of suppliers, vendors and clients. The whole set of one owner is replaced by one command under a
 * version kept in party_contact_versions (the owner row is only locked, never updated: no updated_at change,
 * no CRM-sync trigger). Lock order: owner (FOR NO KEY UPDATE) → version → contacts; the command touches nothing else.
 * Rows from 1C (origin 'onec') are the sync's: the command keeps them and only moves their «основной» flag.
 */
@Injectable()
export class PartyContactsRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<BackendEnv, true>,
  ) {}

  /** The client messengers of migration 269 (BACKEND_CLIENT_CONTACT_EXTRA_KINDS); off when no config is given. */
  extraKindsEnabled(): boolean {
    return this.config?.get('BACKEND_CLIENT_CONTACT_EXTRA_KINDS', { infer: true }) === true;
  }

  /** Kinds a new or changed contact of the owner may have now. */
  kindsNow(party: PartyKind): PartyContactKind[] {
    const config = PARTY_CONFIG[party];
    return config.kinds.filter((kind) => this.extraKindsEnabled() || !config.extraKinds.includes(kind));
  }

  async get(party: PartyKind, partyId: number, client: DatabaseClient = this.database): Promise<PartyContacts> {
    const config = PARTY_CONFIG[party];
    const owner = (await client.query(`SELECT 1 FROM ${config.ownerTable} WHERE ${config.idColumn} = $1`, [partyId])).rows[0];
    if (!owner) throw new ApiError(404, config.notFoundCode, config.notFoundText);
    return {
      party, partyId, version: await this.version(client, config, partyId),
      contacts: (await this.rows(client, config, partyId)).filter((row) => row.available).map(toContact),
      kinds: this.kindsNow(party),
    };
  }

  /** Contacts of many owners at once (list columns). */
  async listFor(party: PartyKind, partyIds: readonly number[]): Promise<Map<number, PartyContacts['contacts']>> {
    const config = PARTY_CONFIG[party];
    const result = new Map<number, PartyContacts['contacts']>();
    if (!partyIds.length) return result;
    const rows = (await this.database.query<ContactRow>(`SELECT ${ROW_COLUMNS(config.idColumn)} FROM ${config.table} c
      WHERE c.${config.idColumn} = ANY($1::bigint[]) AND party_onec_contacts_available(c.onec_source_id, c.onec_snapshot_version)
      ORDER BY c.${config.idColumn}, c.kind, c.is_primary DESC, c.position, c.contact_id`, [partyIds])).rows;
    for (const row of rows) {
      const id = Number(row.owner_id);
      result.set(id, [...(result.get(id) ?? []), toContact(row)]);
    }
    return result;
  }

  /**
   * Replaces the user's own contacts of the set: the owner row is locked, the set version compared, the own rows
   * deleted and the kept ones re-inserted under their own ids (the unique indexes only see the final set); rows from
   * 1C stay and get the «основной» flag and position the command gives them; the version is bumped. Audited with
   * masks only.
   */
  async replace(party: PartyKind, partyId: number, version: number, input: readonly PartyContactInput[], actor: CurrentUser,
    requestId: string, source: string = SOURCE): Promise<PartyContacts> {
    const config = PARTY_CONFIG[party];
    return this.database.transaction(async (tx) => {
      // NO KEY UPDATE: serializes the contact commands (and the 1C sync) of the owner without blocking FK key-share locks on it.
      const owner = (await tx.query(`SELECT 1 FROM ${config.ownerTable} WHERE ${config.idColumn} = $1 FOR NO KEY UPDATE`, [partyId])).rows[0];
      if (!owner) throw new ApiError(404, config.notFoundCode, config.notFoundText);
      const current = await this.version(tx, config, partyId);
      if (current !== version) throw new ApiError(409, PARTY_CONTACTS_VERSION_CONFLICT, 'Контакты уже изменены; обновите страницу');
      const before = await this.rows(tx, config, partyId);
      const frozen = this.extraKindsEnabled() ? [] : config.extraKinds;
      const plan = planContactSet(input, before.map(toStored), config.kinds, config.ownerGenitive, frozen);
      const byId = new Map(before.map((row) => [Number(row.contact_id), row]));
      const actorId = Number(actor.id);
      const keptOwn = new Set(plan.own.filter((line) => line.contactId !== null).map((line) => line.contactId as number));
      const removed = before.filter((row) => row.origin === 'erp' && !keptOwn.has(Number(row.contact_id))).length;
      // «Основной» comes off every row of 1C first: the partial unique index sees only the final flags.
      await tx.query(`UPDATE ${config.table} SET is_primary = FALSE WHERE ${config.idColumn} = $1 AND origin = 'onec' AND is_primary`, [partyId]);
      await tx.query(`DELETE FROM ${config.table} WHERE ${config.idColumn} = $1 AND origin = 'erp'`, [partyId]);
      for (const contact of plan.own) {
        const previous = contact.contactId !== null ? byId.get(contact.contactId) : undefined;
        if (previous) {
          await tx.query(`INSERT INTO ${config.table} (contact_id, ${config.idColumn}, kind, value, value_normalized, is_primary, note, position,
              created_by, created_at, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
          [contact.contactId, partyId, contact.kind, contact.value, contact.valueNormalized, contact.isPrimary, contact.note, contact.position,
            previous.created_by, previous.created_at, actorId]);
        } else {
          await tx.query(`INSERT INTO ${config.table} (${config.idColumn}, kind, value, value_normalized, is_primary, note, position,
              created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [partyId, contact.kind, contact.value, contact.valueNormalized, contact.isPrimary, contact.note, contact.position, actorId]);
        }
      }
      for (const row of plan.onec) {
        const previous = byId.get(row.contactId);
        if (!previous || (previous.is_primary === row.isPrimary && previous.position === row.position)) {
          if (previous?.is_primary) await tx.query(`UPDATE ${config.table} SET is_primary = TRUE WHERE contact_id = $1`, [row.contactId]);
          continue;
        }
        await tx.query(`UPDATE ${config.table} SET is_primary = $2, position = $3, updated_by = $4, updated_at = now() WHERE contact_id = $1`,
          [row.contactId, row.isPrimary, row.position, actorId]);
      }
      await tx.query(`INSERT INTO party_contact_versions (party_kind, party_id, version) VALUES ($1, $2, 1)
        ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now()`, [party, partyId]);
      const after = await this.get(party, partyId, tx);
      await auditService.record(tx, {
        event: config.auditEvent, entityType: party, entityId: partyId,
        actorUserId: actorId, actorUsername: actor.username, actorRole: actor.role, requestId, source,
        ...(party === 'client' ? { relatedClientId: partyId } : {}),
        relatedEntities: [{ entityType: party, entityId: partyId }],
        before: { version, contacts: before.filter((row) => row.available).map((row) => auditView(toContact(row))) },
        after: { version: after.version, contacts: after.contacts.map(auditView) },
        metadata: { added: plan.own.filter((contact) => contact.contactId === null).length, removed },
      });
      return after;
    }).catch((error: unknown) => {
      const record = error as { code?: string } | null;
      // The set is validated before writing and the owner row is locked: a unique violation here is a duplicate value
      // (against a row of 1C that is hidden right now, too).
      if (record?.code === '23505') throw new ApiError(422, PARTY_CONTACT_CODES.duplicate, 'Такой контакт уже есть');
      throw error;
    });
  }

  private async version(client: DatabaseClient, config: PartyConfig, partyId: number): Promise<number> {
    return (await client.query<{ version: number }>('SELECT version FROM party_contact_versions WHERE party_kind = $1 AND party_id = $2',
      [config.kind, partyId])).rows[0]?.version ?? 0;
  }

  /** Every row of the owner, hidden rows of 1C too (`available` says which may be shown). */
  private async rows(client: DatabaseClient, config: PartyConfig, partyId: number): Promise<ContactRow[]> {
    return (await client.query<ContactRow>(`SELECT ${ROW_COLUMNS(config.idColumn)} FROM ${config.table} c WHERE c.${config.idColumn} = $1
      ORDER BY c.kind, c.is_primary DESC, c.position, c.contact_id`, [partyId])).rows;
  }
}

function toContact(row: ContactRow): PartyContact {
  return {
    contactId: Number(row.contact_id), kind: row.kind, value: row.value, valueNormalized: row.value_normalized,
    isPrimary: row.is_primary, note: row.note, origin: row.origin,
  };
}

function toStored(row: ContactRow): StoredContact {
  return {
    contactId: Number(row.contact_id), kind: row.kind, value: row.value, valueNormalized: row.value_normalized, isPrimary: row.is_primary,
    position: row.position, origin: row.origin, available: row.available, note: row.note,
  };
}

/** Audit: kind, origin, primary and a mask — never the value itself; the note only by its length. */
export function auditView(contact: Pick<PartyContact, 'contactId' | 'kind' | 'isPrimary' | 'valueNormalized' | 'note' | 'origin'>) {
  return {
    contactId: contact.contactId, kind: contact.kind, origin: contact.origin, isPrimary: contact.isPrimary,
    masked: maskPartyContact(contact.kind, contact.valueNormalized), noteLength: contact.note?.length ?? 0,
  };
}
