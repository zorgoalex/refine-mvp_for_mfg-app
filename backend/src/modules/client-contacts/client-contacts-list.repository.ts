import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import type { PartyContactKind } from '../party-contacts/party-contacts';

/** Columns of the screen: client phones (client_phones) and the kinds of client_contacts. */
export const CLIENT_CONTACT_COLUMNS = ['phone', 'email', 'telegram', 'whatsapp', 'viber', 'instagram', 'other'] as const;
export type ClientContactColumn = (typeof CLIENT_CONTACT_COLUMNS)[number];
export const CLIENT_CONTACT_SORTS = ['client', 'updated', ...CLIENT_CONTACT_COLUMNS] as const;
export type ClientContactSort = (typeof CLIENT_CONTACT_SORTS)[number];

/** A column filter: has at least one value, has none, or a value containing the text (phones — by digits). */
export type ColumnFilter = { mode: 'has' } | { mode: 'none' } | { mode: 'contains'; text: string };

export interface ClientContactsQuery {
  q: string | null;
  filters: Partial<Record<ClientContactColumn, ColumnFilter>>;
  active: 'active' | 'archived' | 'all';
  sort: ClientContactSort;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface ClientContactsRow {
  client: { id: number; name: string; isActive: boolean; personType: string | null };
  phones: Array<{ phoneId: number; phoneNumber: string; phoneType: string; isPrimary: boolean }>;
  contacts: Array<{ contactId: number; kind: PartyContactKind; value: string; valueNormalized: string; isPrimary: boolean; note: string | null }>;
  /** Version of the client's emails and messengers (the set command compares it). */
  contactsVersion: number;
  /** Last change of a phone or a contact of the client. */
  updatedAt: string | null;
}

/** The digits of a search text: a full national number with a leading 8 reads as 7…; any shorter part stays a fragment. */
export function searchDigits(text: string): string {
  const digits = text.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
}

/** Text for ILIKE: wildcards of the user are literal. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// The digits of a stored client phone, and the same number as 7XXXXXXXXXX (8… and 10-digit numbers): a fragment or a
// full number in either spelling finds it.
const PHONE_DIGITS = `regexp_replace(cp.phone_number, '\\D', '', 'g')`;
const PHONE_NATIONAL = `(CASE WHEN length(${PHONE_DIGITS}) = 11 AND left(${PHONE_DIGITS}, 1) = '8' THEN '7' || substr(${PHONE_DIGITS}, 2)
  WHEN length(${PHONE_DIGITS}) = 10 THEN '7' || ${PHONE_DIGITS} ELSE ${PHONE_DIGITS} END)`;

const SORT_SQL: Record<ClientContactSort, string> = {
  client: 'c.client_name',
  updated: `(SELECT max(t) FROM (SELECT max(coalesce(cp.updated_at, cp.created_at))::timestamptz AS t FROM client_phones cp WHERE cp.client_id = c.client_id
             UNION ALL SELECT max(cc.updated_at)::timestamptz FROM client_contacts cc WHERE cc.client_id = c.client_id) changes)`,
  phone: `(SELECT ${PHONE_NATIONAL} FROM client_phones cp WHERE cp.client_id = c.client_id ORDER BY cp.is_primary DESC, cp.phone_id LIMIT 1)`,
  email: kindSort('email'),
  telegram: kindSort('telegram'),
  whatsapp: kindSort('whatsapp'),
  viber: kindSort('viber'),
  instagram: kindSort('instagram'),
  other: kindSort('other'),
};

function kindSort(kind: PartyContactKind): string {
  return `(SELECT cc.value_normalized FROM client_contacts cc WHERE cc.client_id = c.client_id AND cc.kind = '${kind}'
           ORDER BY cc.is_primary DESC, cc.position, cc.contact_id LIMIT 1)`;
}

interface ListRow extends QueryResultRow { client_id: string; client_name: string; is_active: boolean; person_type: string | null; total: string }

/**
 * The «Контакты клиентов» list: one row per client with its phones and contacts. Search, column filters, sorting and
 * pages are done in SQL over clients, client_phones and client_contacts (no Hasura: client_contacts is not tracked there).
 */
@Injectable()
export class ClientContactsListRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(query: ClientContactsQuery): Promise<{ items: ClientContactsRow[]; total: number }> {
    const params: unknown[] = [];
    const param = (value: unknown) => `$${params.push(value)}`;
    const where: string[] = [];
    if (query.active !== 'all') where.push(`c.is_active = ${query.active === 'active' ? 'true' : 'false'}`);

    if (query.q) {
      const text = param(likePattern(query.q));
      const lower = param(likePattern(query.q.toLowerCase()));
      const digits = searchDigits(query.q);
      const alternatives = [
        `c.client_name::text ILIKE ${text}`,
        `EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.client_id
           AND (cc.value ILIKE ${text} OR cc.value_normalized LIKE ${lower} OR cc.note ILIKE ${text}))`,
        `EXISTS (SELECT 1 FROM client_phones cp WHERE cp.client_id = c.client_id AND cp.phone_number ILIKE ${text})`,
      ];
      if (digits.length >= 3) {
        const pattern = param(likePattern(digits));
        alternatives.push(`EXISTS (SELECT 1 FROM client_phones cp WHERE cp.client_id = c.client_id
           AND (${PHONE_DIGITS} LIKE ${pattern} OR ${PHONE_NATIONAL} LIKE ${pattern}))`);
        alternatives.push(`EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.client_id
           AND cc.kind IN ('whatsapp', 'viber') AND cc.value_normalized LIKE ${pattern})`);
      }
      where.push(`(${alternatives.join(' OR ')})`);
    }

    for (const column of CLIENT_CONTACT_COLUMNS) {
      const filter = query.filters[column];
      if (!filter) continue;
      const exists = column === 'phone'
        ? (condition: string) => `EXISTS (SELECT 1 FROM client_phones cp WHERE cp.client_id = c.client_id${condition})`
        : (condition: string) => `EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.client_id AND cc.kind = ${param(column)}${condition})`;
      if (filter.mode === 'has') where.push(exists(''));
      else if (filter.mode === 'none') where.push(`NOT ${exists('')}`);
      else if (column === 'phone' || column === 'whatsapp' || column === 'viber') {
        const digits = searchDigits(filter.text);
        if (digits) {
          const pattern = param(likePattern(digits));
          where.push(exists(column === 'phone'
            ? ` AND (${PHONE_DIGITS} LIKE ${pattern} OR ${PHONE_NATIONAL} LIKE ${pattern})`
            : ` AND cc.value_normalized LIKE ${pattern}`));
        } else {
          const text = param(likePattern(filter.text));
          where.push(exists(column === 'phone' ? ` AND cp.phone_number ILIKE ${text}` : ` AND (cc.value ILIKE ${text} OR cc.note ILIKE ${text})`));
        }
      } else {
        const text = param(likePattern(filter.text));
        where.push(exists(` AND (cc.value ILIKE ${text} OR cc.value_normalized LIKE ${param(likePattern(filter.text.toLowerCase()))} OR cc.note ILIKE ${text})`));
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const direction = query.order === 'desc' ? 'DESC' : 'ASC';
    const limit = param(query.pageSize);
    const offset = param((query.page - 1) * query.pageSize);
    const rows = (await this.database.query<ListRow>(`
      SELECT c.client_id, c.client_name::text AS client_name, c.is_active, c.person_type, count(*) OVER () AS total
        FROM clients c
        ${whereSql}
       ORDER BY ${SORT_SQL[query.sort]} ${direction} NULLS LAST, c.client_id ${direction}
       LIMIT ${limit} OFFSET ${offset}`, params)).rows;
    const total = rows[0] ? Number(rows[0].total) : await this.count(whereSql, params.slice(0, params.length - 2));
    return { items: await this.rowsFor(rows), total };
  }

  /** The page was empty (past the end): the total still answers. */
  private async count(whereSql: string, params: unknown[]): Promise<number> {
    const result = await this.database.query<{ total: string }>(`SELECT count(*) AS total FROM clients c ${whereSql}`, params);
    return Number(result.rows[0]?.total ?? 0);
  }

  /** One client (the row after a save or a stale answer). */
  async row(clientId: number): Promise<ClientContactsRow | null> {
    const rows = (await this.database.query<ListRow>(`SELECT client_id, client_name::text AS client_name, is_active, person_type, 1 AS total
      FROM clients WHERE client_id = $1`, [clientId])).rows;
    return (await this.rowsFor(rows))[0] ?? null;
  }

  /**
   * Phones, contacts and the contacts version of the clients in ONE statement (one snapshot): the version the editor
   * sends back always belongs to the contacts it showed, so a change committed in between is a 409, not a lost update.
   */
  private async rowsFor(clients: readonly ListRow[]): Promise<ClientContactsRow[]> {
    if (!clients.length) return [];
    const ids = clients.map((row) => Number(row.client_id));
    const result = await this.database.query<{ client_id: string; phones: ClientContactsRow['phones']; contacts: ClientContactsRow['contacts'];
      version: number | null; updated_at: Date | null }>(`
      SELECT c.client_id,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('phoneId', p.phone_id, 'phoneNumber', p.phone_number, 'phoneType', p.phone_type,
                       'isPrimary', p.is_primary) ORDER BY p.is_primary DESC, p.phone_id), '[]'::jsonb)
                FROM client_phones p WHERE p.client_id = c.client_id) AS phones,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('contactId', cc.contact_id, 'kind', cc.kind, 'value', cc.value,
                       'valueNormalized', cc.value_normalized, 'isPrimary', cc.is_primary, 'note', cc.note)
                       ORDER BY cc.kind, cc.is_primary DESC, cc.position, cc.contact_id), '[]'::jsonb)
                FROM client_contacts cc WHERE cc.client_id = c.client_id) AS contacts,
             (SELECT v.version FROM party_contact_versions v WHERE v.party_kind = 'client' AND v.party_id = c.client_id) AS version,
             ${SORT_SQL.updated} AS updated_at
        FROM clients c
       WHERE c.client_id = ANY($1::bigint[])`, [ids]);
    const byClient = new Map(result.rows.map((row) => [Number(row.client_id), row]));
    return clients.flatMap((client) => {
      const row = byClient.get(Number(client.client_id));
      if (!row) return [];
      return [{
        client: { id: Number(client.client_id), name: client.client_name, isActive: client.is_active, personType: client.person_type },
        phones: row.phones.map((phone) => ({ ...phone, phoneId: Number(phone.phoneId) })),
        contacts: row.contacts.map((contact) => ({ ...contact, contactId: Number(contact.contactId) })),
        contactsVersion: row.version ?? 0,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      }];
    });
  }
}
