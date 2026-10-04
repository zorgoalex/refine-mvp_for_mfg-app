import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { maskContact, prepareContacts, type EmployeeContactInput, type EmployeeContactKind } from '../employees/employee-contacts';
import { PARTY_CONFIG, PARTY_CONTACT_CODES, PARTY_CONTACTS_VERSION_CONFLICT, type PartyConfig, type PartyContacts, type PartyKind } from './party-contacts';

const SOURCE = 'erp_party_contacts';

interface ContactRow extends QueryResultRow {
  contact_id: string; owner_id: string; kind: EmployeeContactKind; value: string; value_normalized: string; is_primary: boolean;
  note: string | null; position: number; created_by: string | null; created_at: Date;
}

/**
 * Contacts of suppliers, vendors and clients. The whole set of one owner is replaced by one command under a
 * version kept in party_contact_versions (the owner row is only locked, never updated: no updated_at change,
 * no CRM-sync trigger). Lock order: owner (FOR NO KEY UPDATE) → version → contacts; the command touches nothing else.
 */
@Injectable()
export class PartyContactsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(party: PartyKind, partyId: number, client: DatabaseClient = this.database): Promise<PartyContacts> {
    const config = PARTY_CONFIG[party];
    const owner = (await client.query(`SELECT 1 FROM ${config.ownerTable} WHERE ${config.idColumn} = $1`, [partyId])).rows[0];
    if (!owner) throw new ApiError(404, config.notFoundCode, config.notFoundText);
    return { party, partyId, version: await this.version(client, config, partyId), contacts: (await this.rows(client, config, partyId)).map(toContact) };
  }

  /** Contacts of many owners at once (list columns). */
  async listFor(party: PartyKind, partyIds: readonly number[]): Promise<Map<number, PartyContacts['contacts']>> {
    const config = PARTY_CONFIG[party];
    const result = new Map<number, PartyContacts['contacts']>();
    if (!partyIds.length) return result;
    const rows = (await this.database.query<ContactRow>(`SELECT c.*, c.${config.idColumn} AS owner_id FROM ${config.table} c
      WHERE c.${config.idColumn} = ANY($1::bigint[]) ORDER BY c.${config.idColumn}, c.kind, c.is_primary DESC, c.position, c.contact_id`, [partyIds])).rows;
    for (const row of rows) {
      const id = Number(row.owner_id);
      result.set(id, [...(result.get(id) ?? []), toContact(row)]);
    }
    return result;
  }

  /**
   * Replaces the set: the owner row is locked, the set version compared, the old set deleted and the kept
   * contacts re-inserted under their own ids (the unique indexes only see the final set), the version bumped.
   * Audited with masks only.
   */
  async replace(party: PartyKind, partyId: number, version: number, input: readonly EmployeeContactInput[], actor: CurrentUser,
    requestId: string): Promise<PartyContacts> {
    const config = PARTY_CONFIG[party];
    const prepared = prepareContacts(input, PARTY_CONTACT_CODES, config.ownerGenitive);
    const foreign = prepared.find((contact) => !config.kinds.includes(contact.kind));
    if (foreign) {
      throw new ApiError(422, PARTY_CONTACT_CODES.invalid, party === 'client'
        ? 'Телефоны клиента ведутся в списке телефонов клиента' : 'Этот вид контакта здесь не ведётся', { kind: foreign.kind });
    }
    return this.database.transaction(async (tx) => {
      // NO KEY UPDATE: serializes the contact commands of the owner without blocking FK key-share locks on it.
      const owner = (await tx.query(`SELECT 1 FROM ${config.ownerTable} WHERE ${config.idColumn} = $1 FOR NO KEY UPDATE`, [partyId])).rows[0];
      if (!owner) throw new ApiError(404, config.notFoundCode, config.notFoundText);
      const current = await this.version(tx, config, partyId);
      if (current !== version) throw new ApiError(409, PARTY_CONTACTS_VERSION_CONFLICT, 'Контакты уже изменены; обновите страницу');
      const before = await this.rows(tx, config, partyId);
      const byId = new Map(before.map((row) => [Number(row.contact_id), row]));
      for (const contact of prepared) {
        if (contact.contactId !== null && !byId.has(contact.contactId)) {
          throw new ApiError(409, PARTY_CONTACTS_VERSION_CONFLICT, 'Контакт уже удалён; обновите страницу');
        }
      }
      const kept = new Set(prepared.filter((contact) => contact.contactId !== null).map((contact) => contact.contactId as number));
      const actorId = Number(actor.id);
      const removed = before.filter((row) => !kept.has(Number(row.contact_id))).length;
      await tx.query(`DELETE FROM ${config.table} WHERE ${config.idColumn} = $1`, [partyId]);
      for (const contact of prepared) {
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
      await tx.query(`INSERT INTO party_contact_versions (party_kind, party_id, version) VALUES ($1, $2, 1)
        ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now()`, [party, partyId]);
      const after = await this.get(party, partyId, tx);
      await auditService.record(tx, {
        event: config.auditEvent, entityType: party, entityId: partyId,
        actorUserId: actorId, actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        ...(party === 'client' ? { relatedClientId: partyId } : {}),
        relatedEntities: [{ entityType: party, entityId: partyId }],
        before: { version, contacts: before.map((row) => auditView(toContact(row))) },
        after: { version: after.version, contacts: after.contacts.map(auditView) },
        metadata: { added: prepared.filter((contact) => contact.contactId === null).length, removed },
      });
      return after;
    }).catch((error: unknown) => {
      const record = error as { code?: string } | null;
      // The set is validated before writing and the owner row is locked: a unique violation here is a duplicate value.
      if (record?.code === '23505') throw new ApiError(422, PARTY_CONTACT_CODES.duplicate, 'Такой контакт уже есть');
      throw error;
    });
  }

  private async version(client: DatabaseClient, config: PartyConfig, partyId: number): Promise<number> {
    return (await client.query<{ version: number }>('SELECT version FROM party_contact_versions WHERE party_kind = $1 AND party_id = $2',
      [config.kind, partyId])).rows[0]?.version ?? 0;
  }

  private async rows(client: DatabaseClient, config: PartyConfig, partyId: number): Promise<ContactRow[]> {
    return (await client.query<ContactRow>(`SELECT c.*, c.${config.idColumn} AS owner_id FROM ${config.table} c WHERE c.${config.idColumn} = $1
      ORDER BY c.kind, c.is_primary DESC, c.position, c.contact_id`, [partyId])).rows;
  }
}

function toContact(row: ContactRow): PartyContacts['contacts'][number] {
  return {
    contactId: Number(row.contact_id), kind: row.kind, value: row.value, valueNormalized: row.value_normalized,
    isPrimary: row.is_primary, note: row.note,
  };
}

/** Audit: kind, primary and a mask — never the value itself; the note only by its length. */
function auditView(contact: PartyContacts['contacts'][number]) {
  return {
    contactId: contact.contactId, kind: contact.kind, isPrimary: contact.isPrimary,
    masked: maskContact(contact.kind, contact.valueNormalized), noteLength: contact.note?.length ?? 0,
  };
}
