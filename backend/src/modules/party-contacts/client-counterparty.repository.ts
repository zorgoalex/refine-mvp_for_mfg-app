import { Inject, Injectable, Logger } from '@nestjs/common';
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
/** One confirmation request: each pair is its own transaction, so the request stays short. */
export const CONFIRM_MAX = 100;
const MATCHES_LIMIT = 2000;

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

export type ClientMatchStrength = 'both' | 'phone' | 'name';

/** A client without a counterparty and the only counterparty that looks like it. */
export interface ClientCounterpartyMatch {
  clientId: number;
  clientName: string;
  clientPhones: string[];
  counterparty: CounterpartyCard;
  /** Equal name and phone, equal phone only, equal name only. */
  strength: ClientMatchStrength;
}

/** A client whose exact candidates cannot be confirmed in bulk: several of them, or a shared or taken one. */
export interface ClientCounterpartyAmbiguity {
  clientId: number;
  clientName: string;
  candidates: Array<{ refKey1c: string; name: string; matchedBy: ClientCounterpartyReason[] }>;
}

export interface ClientCounterpartyMatches {
  available: boolean;
  summary: {
    /** Active clients. */
    clients: number;
    linked: number;
    /** Not linked, exactly one exact candidate, free and not a candidate of another unlinked client. */
    both: number;
    phone: number;
    name: number;
    ambiguous: number;
    /** Not linked and nothing exact found. */
    none: number;
  };
  matches: ClientCounterpartyMatch[];
  ambiguous: ClientCounterpartyAmbiguity[];
}

export type ConfirmStatus = 'linked' | 'conflict' | 'taken' | 'unknown' | 'not_found' | 'uncertain';

export interface ConfirmResult {
  clientId: number;
  refKey1c: string;
  status: ConfirmStatus;
  /** For `taken`: the client that holds the counterparty; for `conflict`: nothing — the client got another link meanwhile. */
  holderClientId: number | null;
  holderClientName: string | null;
}

const CONFIRM_ERRORS: Record<string, ConfirmStatus> = {
  CLIENT_COUNTERPARTY_CONFLICT: 'conflict',
  CLIENT_COUNTERPARTY_TAKEN: 'taken',
  CLIENT_COUNTERPARTY_UNKNOWN: 'unknown',
  CLIENT_NOT_FOUND: 'not_found',
};

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
  private readonly logger = new Logger(ClientCounterpartyRepository.name);

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
   * Bulk view: active clients without a counterparty and their exact candidates (equal name, equal phone).
   * A pair is offered for confirmation only when it is unambiguous both ways — the client has one exact
   * candidate, that counterparty is free and is not an exact candidate of another unlinked client. Everything
   * else is listed as ambiguous and is resolved in the card of the client.
   */
  async matches(client: DatabaseClient = this.database): Promise<ClientCounterpartyMatches> {
    const totals = (await client.query<{ clients: number; linked: number }>(
      `SELECT count(*)::int AS clients, count(ref_key_1c)::int AS linked FROM clients WHERE is_active`)).rows[0];
    const empty = { clients: totals.clients, linked: totals.linked, both: 0, phone: 0, name: 0, ambiguous: 0, none: totals.clients - totals.linked };
    if (!(await this.available(client))) return { available: false, summary: empty, matches: [], ambiguous: [] };
    const rows = (await client.query<CounterpartyRow & {
      client_id: string; client_name: string; client_phones: string[] | null; reasons: string[]; client_pairs: number; counterparty_pairs: number; holder: string | null;
    }>(
      `WITH ${COUNTERPARTIES},
         cpn AS (SELECT cp.ref, ${normalizedName('cp.name')} AS n FROM cp),
         cl AS (SELECT c.client_id, c.client_name::text AS client_name, ${normalizedName('c.client_name::text')} AS n
                  FROM clients c WHERE c.is_active AND c.ref_key_1c IS NULL),
         clp AS (SELECT DISTINCT p.client_id, ${normalizedPhone('p.phone_number')} AS p FROM client_phones p JOIN cl ON cl.client_id = p.client_id),
         hit AS (
           SELECT cl.client_id, cpn.ref, 'name' AS reason FROM cl JOIN cpn ON cpn.n = cl.n WHERE cl.n <> ''
           UNION ALL
           SELECT clp.client_id, cpp.ref, 'phone' FROM clp JOIN cpp ON cpp.p = clp.p JOIN cp ON cp.ref = cpp.ref WHERE length(cpp.p) = 10),
         pair AS (SELECT client_id, ref, array_agg(DISTINCT reason ORDER BY reason) AS reasons FROM hit GROUP BY client_id, ref),
         counted AS (
           SELECT pair.*, count(*) OVER (PARTITION BY pair.client_id)::int AS client_pairs, count(*) OVER (PARTITION BY pair.ref)::int AS counterparty_pairs
             FROM pair)
       SELECT counted.client_id, cl.client_name, counted.reasons, counted.client_pairs, counted.counterparty_pairs,
              (SELECT array_agg(x.phone_number ORDER BY x.phone_number) FROM (SELECT DISTINCT p.phone_number FROM client_phones p WHERE p.client_id = counted.client_id) x) AS client_phones,
              (SELECT h.client_id::text FROM clients h WHERE lower(h.ref_key_1c::text) = cp.ref) AS holder,
              ${CARD_COLUMNS}
         FROM counted JOIN cl ON cl.client_id = counted.client_id JOIN cp ON cp.ref = counted.ref
        ORDER BY cl.client_name, counted.client_id, cp.name, cp.ref`)).rows;
    const matches: ClientCounterpartyMatch[] = [];
    const ambiguous = new Map<number, ClientCounterpartyAmbiguity>();
    for (const row of rows) {
      const clientId = Number(row.client_id);
      const reasons = row.reasons as ClientCounterpartyReason[];
      if (row.client_pairs === 1 && row.counterparty_pairs === 1 && row.holder === null) {
        matches.push({
          clientId, clientName: row.client_name, clientPhones: row.client_phones ?? [], counterparty: toCard(row),
          strength: reasons.length === 2 ? 'both' : reasons[0] === 'phone' ? 'phone' : 'name',
        });
      } else {
        const entry = ambiguous.get(clientId) ?? { clientId, clientName: row.client_name, candidates: [] };
        entry.candidates.push({ refKey1c: row.ref, name: row.name, matchedBy: reasons });
        ambiguous.set(clientId, entry);
      }
    }
    const count = (strength: ClientMatchStrength) => matches.filter((match) => match.strength === strength).length;
    const summary = {
      clients: totals.clients, linked: totals.linked, both: count('both'), phone: count('phone'), name: count('name'), ambiguous: ambiguous.size,
      none: totals.clients - totals.linked - matches.length - ambiguous.size,
    };
    const order: Record<ClientMatchStrength, number> = { both: 0, phone: 1, name: 2 };
    matches.sort((a, b) => order[a.strength] - order[b.strength]);
    return { available: true, summary, matches: matches.slice(0, MATCHES_LIMIT), ambiguous: [...ambiguous.values()].slice(0, MATCHES_LIMIT) };
  }

  /**
   * Confirms pairs the user saw in the bulk view: each pair is the ordinary link command of a client that had
   * no counterparty (its own transaction, its own audit row marked as a bulk confirmation). A pair that is no
   * longer possible — the client got a link, the counterparty was taken or left 1C — is reported and skipped;
   * the others are still linked. An unexpected failure of one pair never hides the pairs already linked; it is
   * reported as `uncertain`: the transaction usually rolled back, but a failure while the commit was being
   * acknowledged leaves the link written — the caller learns the truth by reading the link of the client, never
   * by sending the pair again (a repeat would bring back a link somebody removed meanwhile).
   */
  async confirm(pairs: ReadonlyArray<{ clientId: number; refKey1c: string }>, actor: CurrentUser, requestId: string): Promise<ConfirmResult[]> {
    const results: ConfirmResult[] = [];
    for (const pair of pairs) {
      try {
        await this.setLink(pair.clientId, pair.refKey1c, null, actor, requestId, 'bulk_confirm');
        results.push({ ...pair, status: 'linked', holderClientId: null, holderClientName: null });
      } catch (error) {
        const known = error instanceof ApiError ? CONFIRM_ERRORS[error.code] : undefined;
        if (!known) this.logger.error(`bulk confirm of client ${pair.clientId} failed (request ${requestId}): ${error instanceof Error ? error.message : String(error)}`);
        const status: ConfirmStatus = known ?? 'uncertain';
        const holder = status === 'taken' ? (error as ApiError).details as { clientId?: number; clientName?: string } | undefined : undefined;
        results.push({ ...pair, status, holderClientId: holder?.clientId ?? null, holderClientName: holder?.clientName ?? null });
      }
    }
    return results;
  }

  /**
   * Links, relinks or unlinks. `expected` is the key the caller saw: another key under the lock is a conflict
   * (nobody's link is overwritten blindly); the key already being the new one is a repeat — no second audit.
   * A counterparty of another client is refused: it is unlinked there first, by a separate audited command.
   */
  async setLink(
    clientId: number, refKey1c: string | null, expected: string | null, actor: CurrentUser, requestId: string, via: 'card' | 'bulk_confirm' = 'card',
  ): Promise<ClientLink> {
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
        metadata: { counterpartyCode: (after ?? before)?.code ?? null, counterpartyBin: (after ?? before)?.bin ?? null, via },
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
