import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { normalizedName, normalizedPhone } from '../onec-agent/domain/onec-matching-sql';

const SOURCE = 'erp_party_contacts';
/** Similar names (pg_trgm) are offered from this similarity up — the threshold of the 1C «Сопоставление» tab. */
const SIMILARITY_FROM = 0.45;
const SUGGESTIONS_LIMIT = 10;
const SEARCH_LIMIT = 50;

export type ClientCounterpartyReason = 'name' | 'phone' | 'similar';

export interface CounterpartyCard {
  /** 1C counterparty ref key (uuid, lower case). */
  refKey1c: string;
  name: string;
  code: string | null;
  bin: string | null;
  /** Marked as a buyer in 1C (null when the source does not say). */
  isBuyer: boolean | null;
  phones: string[];
}

export interface ClientCounterparty extends CounterpartyCard {
  /** Why it is offered for the client: equal name, equal phone, similar name. Empty for a text search. */
  matchedBy: ClientCounterpartyReason[];
  /** The client already linked to this counterparty. */
  clientId: number | null;
  clientName: string | null;
}

export interface ClientLink {
  clientId: number;
  clientName: string;
  refKey1c: string | null;
  /** Counterparties of 1C are loaded: without them nothing can be chosen. */
  available: boolean;
  /** The linked counterparty as 1C has it now; null — no link, or the key is not in the loaded 1C data. */
  counterparty: CounterpartyCard | null;
}

interface CounterpartyRow {
  ref: string; name: string; code: string | null; bin: string | null; is_buyer: boolean | null; phones: string[] | null;
  matched_by?: string[] | null; client_id?: string | null; client_name?: string | null;
}

/** Counterparties of the 1C copy that can be linked: not a folder, not marked for deletion, still in the source. */
const COUNTERPARTIES = `
  cp AS (
    SELECT DISTINCT ON (lower(m.source_key)) lower(m.source_key) AS ref,
           COALESCE(NULLIF(btrim(m.data->>'Description'), ''), m.source_key) AS name,
           NULLIF(btrim(m.data->>'Code'), '') AS code, NULLIF(btrim(m.data->>'ИдентификационныйНомер'), '') AS bin,
           (m.data->>'Покупатель') = 'true' AS is_buyer
      FROM onec_etl_mirror_rows m
     WHERE m.entity_code = 'counterparties' AND NOT m.deleted AND m.missing_in_source_at IS NULL
       AND COALESCE(m.data->>'IsFolder', 'false') <> 'true' AND COALESCE(m.data->>'DeletionMark', 'false') <> 'true'
       AND lower(m.source_key) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY lower(m.source_key), m.source_id),
  cpp AS (
    SELECT DISTINCT lower(m.data->>'Ref_Key') AS ref, btrim(m.data->>'Представление') AS raw,
           ${normalizedPhone("m.data->>'Представление'")} AS p
      FROM onec_etl_mirror_rows m
     WHERE m.entity_code = 'counterparty_phones' AND NOT m.deleted AND m.missing_in_source_at IS NULL
       AND btrim(COALESCE(m.data->>'Представление', '')) <> '')`;

const CARD_COLUMNS = `cp.ref, cp.name, cp.code, cp.bin, cp.is_buyer,
  (SELECT array_agg(x.raw ORDER BY x.raw) FROM (SELECT DISTINCT cpp.raw FROM cpp WHERE cpp.ref = cp.ref) x) AS phones`;

/**
 * The link of a client to a 1C counterparty (`clients.ref_key_1c`): one counterparty for a client and one
 * client for a counterparty. It is changed only here — compare-and-swap on the previous key, audited — so
 * that documents of the counterparty in 1C can be accounted against the client. Nothing but the key (and
 * `edited_by`) of the client row is written; the row update queues the usual CRM sync of the client.
 */
@Injectable()
export class ClientCounterpartyRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async link(clientId: number, client: DatabaseClient = this.database): Promise<ClientLink> {
    const row = (await client.query<{ client_name: string; ref: string | null }>(
      'SELECT client_name::text AS client_name, lower(ref_key_1c::text) AS ref FROM clients WHERE client_id = $1', [clientId])).rows[0];
    if (!row) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    const available = await this.available(client);
    return {
      clientId, clientName: row.client_name, refKey1c: row.ref, available,
      counterparty: row.ref && available ? await this.card(client, row.ref) : null,
    };
  }

  /**
   * Counterparties to choose from. With a search text — by name, code, BIN or phone digits. Without it — what
   * looks like the client: the same name, the same phone, a similar name (when pg_trgm is installed).
   */
  async candidates(clientId: number, search: string | null, client: DatabaseClient = this.database): Promise<ClientCounterparty[]> {
    if (!(await this.exists(client, clientId))) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    if (!(await this.available(client))) return [];
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      // A phone is searched only by a text of phone characters, by its national part: "8701…" and "+7701…" are one number.
      const digits = /^[\d\s()+-]+$/.test(search) ? search.replace(/\D/g, '') : '';
      const phone = digits.length >= 4 ? `%${digits.length >= 11 ? digits.slice(-10) : digits}%` : null;
      const national = digits.length >= 5 && digits.length <= 10 && /^[78]/.test(digits) ? `%${digits.slice(1)}%` : null;
      const rows = (await client.query<CounterpartyRow>(
        `WITH ${COUNTERPARTIES}
         SELECT ${CARD_COLUMNS}, ARRAY[]::text[] AS matched_by, c.client_id, c.client_name::text AS client_name
           FROM cp LEFT JOIN clients c ON lower(c.ref_key_1c::text) = cp.ref
          WHERE cp.name ILIKE $1 ESCAPE '\\' OR cp.code ILIKE $1 ESCAPE '\\' OR cp.bin ILIKE $1 ESCAPE '\\'
             OR ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM cpp WHERE cpp.ref = cp.ref AND (cpp.p LIKE $2 OR cpp.p LIKE $4)))
          ORDER BY cp.is_buyer DESC NULLS LAST, cp.name, cp.ref LIMIT $3`, [like, phone, SEARCH_LIMIT, national])).rows;
      return rows.map(toCandidate);
    }
    const trigram = (await client.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok`)).rows[0]?.ok === true;
    const similar = trigram
      ? `UNION ALL
         SELECT cp.ref, 'similar', similarity(${normalizedName('cp.name')}, me.n)::float8 FROM cp CROSS JOIN me
          WHERE me.n <> '' AND ${normalizedName('cp.name')} <> me.n AND similarity(${normalizedName('cp.name')}, me.n) >= ${SIMILARITY_FROM}`
      : '';
    const rows = (await client.query<CounterpartyRow>(
      `WITH ${COUNTERPARTIES},
         me AS (SELECT ${normalizedName('client_name::text')} AS n FROM clients WHERE client_id = $1),
         myp AS (SELECT DISTINCT ${normalizedPhone('phone_number')} AS p FROM client_phones WHERE client_id = $1),
         hit AS (
           SELECT cp.ref, 'name' AS reason, 1::float8 AS score FROM cp CROSS JOIN me WHERE me.n <> '' AND ${normalizedName('cp.name')} = me.n
           UNION ALL
           SELECT cpp.ref, 'phone', 1::float8 FROM cpp JOIN myp ON myp.p = cpp.p WHERE length(cpp.p) = 10
           ${similar}),
         agg AS (
           SELECT ref, array_agg(DISTINCT reason ORDER BY reason) AS matched_by,
                  count(DISTINCT reason) FILTER (WHERE reason <> 'similar') AS exact, max(score) FILTER (WHERE reason = 'similar') AS score
             FROM hit GROUP BY ref)
       SELECT ${CARD_COLUMNS}, agg.matched_by, c.client_id, c.client_name::text AS client_name
         FROM agg JOIN cp ON cp.ref = agg.ref LEFT JOIN clients c ON lower(c.ref_key_1c::text) = cp.ref
        ORDER BY agg.exact DESC, agg.score DESC NULLS LAST, cp.name, cp.ref LIMIT $2`, [clientId, SUGGESTIONS_LIMIT])).rows;
    return rows.map(toCandidate);
  }

  /**
   * Links, relinks or unlinks. `expected` is the key the caller saw: another key under the lock is a conflict
   * (nobody's link is overwritten blindly); the key already being the new one is a repeat — no second audit.
   * A counterparty of another client is refused: it is unlinked there first, by a separate audited command.
   */
  async setLink(clientId: number, refKey1c: string | null, expected: string | null, actor: CurrentUser, requestId: string): Promise<ClientLink> {
    return this.database.transaction(async (tx) => {
      // Two clients taking one counterparty wait for each other here; the unique index is the last line of defence.
      if (refKey1c) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`client-counterparty:${refKey1c}`]);
      const row = (await tx.query<{ ref: string | null }>(
        'SELECT lower(ref_key_1c::text) AS ref FROM clients WHERE client_id = $1 FOR NO KEY UPDATE', [clientId])).rows[0];
      if (!row) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
      if (row.ref === refKey1c) return this.link(clientId, tx);
      if (row.ref !== expected) {
        throw new ApiError(409, 'CLIENT_COUNTERPARTY_CONFLICT', 'Сопоставление с контрагентом 1С уже изменено; обновите страницу', { refKey1c: row.ref });
      }
      const available = await this.available(tx);
      const before = row.ref && available ? await this.card(tx, row.ref) : null;
      const after = refKey1c ? await this.requireKnown(tx, refKey1c, available) : null;
      if (refKey1c) {
        const holder = (await tx.query<{ client_id: string; client_name: string }>(
          'SELECT client_id, client_name::text AS client_name FROM clients WHERE ref_key_1c = $1::uuid AND client_id <> $2', [refKey1c, clientId])).rows[0];
        if (holder) throw takenError(Number(holder.client_id), holder.client_name);
      }
      const actorId = Number(actor.id);
      await tx.query('UPDATE clients SET ref_key_1c = $2::uuid, edited_by = $3 WHERE client_id = $1', [clientId, refKey1c, actorId]);
      await auditService.record(tx, {
        event: refKey1c ? 'client.counterparty_linked' : 'client.counterparty_unlinked', entityType: 'client', entityId: clientId,
        actorUserId: actorId, actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        relatedClientId: clientId,
        relatedEntities: [{ entityType: 'client', entityId: clientId }],
        before: { refKey1c: row.ref, counterpartyName: before?.name ?? null },
        after: { refKey1c, counterpartyName: after?.name ?? null },
        metadata: { counterpartyCode: (after ?? before)?.code ?? null, counterpartyBin: (after ?? before)?.bin ?? null },
      });
      return this.link(clientId, tx);
    }).catch((error: unknown) => { throw taken(error); });
  }

  /** Only a counterparty of the loaded 1C data can be linked: a typed key would silently link nothing. */
  private async requireKnown(tx: TransactionClient, refKey1c: string, available: boolean): Promise<CounterpartyCard> {
    if (!available) throw new ApiError(422, 'CLIENT_COUNTERPARTY_UNKNOWN', 'Данные контрагентов 1С не загружены');
    const card = await this.card(tx, refKey1c);
    if (!card) throw new ApiError(422, 'CLIENT_COUNTERPARTY_UNKNOWN', 'Такого контрагента 1С нет в загруженных данных');
    return card;
  }

  private async card(client: DatabaseClient, refKey1c: string): Promise<CounterpartyCard | null> {
    const row = (await client.query<CounterpartyRow>(`WITH ${COUNTERPARTIES} SELECT ${CARD_COLUMNS} FROM cp WHERE cp.ref = $1`, [refKey1c])).rows[0];
    return row ? toCard(row) : null;
  }

  private async exists(client: DatabaseClient, clientId: number): Promise<boolean> {
    return (await client.query('SELECT 1 FROM clients WHERE client_id = $1', [clientId])).rows.length > 0;
  }

  /** The 1C module is installed and its counterparties are loaded. */
  private async available(client: DatabaseClient): Promise<boolean> {
    const installed = (await client.query<{ ok: boolean }>(`SELECT to_regclass('onec_etl_mirror_rows') IS NOT NULL AS ok`)).rows[0]?.ok === true;
    return installed && (await client.query(`SELECT 1 FROM onec_etl_mirror_rows WHERE entity_code = 'counterparties' LIMIT 1`)).rows.length > 0;
  }
}

function toCard(row: CounterpartyRow): CounterpartyCard {
  return { refKey1c: row.ref, name: row.name, code: row.code, bin: row.bin, isBuyer: row.is_buyer, phones: row.phones ?? [] };
}

function toCandidate(row: CounterpartyRow): ClientCounterparty {
  return {
    ...toCard(row),
    matchedBy: (row.matched_by ?? []) as ClientCounterpartyReason[],
    clientId: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    clientName: row.client_name ?? null,
  };
}

function takenError(clientId: number | null, clientName: string | null): ApiError {
  return new ApiError(409, 'CLIENT_COUNTERPARTY_TAKEN', 'Этот контрагент 1С уже сопоставлен с другим клиентом',
    clientId === null ? undefined : { clientId, clientName });
}

/** The unique index on clients.ref_key_1c: the counterparty already belongs to another client. */
function taken(error: unknown): unknown {
  const record = error as { code?: string; constraint?: string } | null;
  if (record?.code === '23505' && String(record.constraint ?? '').includes('ref_key_1c')) return takenError(null, null);
  return error;
}
