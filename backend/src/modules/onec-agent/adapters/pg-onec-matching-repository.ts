import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { livePersonalSnapshotJoin, normalizedName, normalizedPhone } from '../domain/onec-matching-sql';

/**
 * Read-only matching of the 1C copy against ERP reference data (plan §9 «Сопоставление»): nothing is
 * written anywhere. ERP has no BIN and no 1C keys yet (clients.ref_key_1c is empty), so a counterparty
 * is matched by the 1C key when present, by normalized name, and — for clients — by phone.
 */

export type CounterpartyMatchStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface CounterpartyMatchFilter {
  sourceId: number;
  status: CounterpartyMatchStatus | 'all';
  role: 'buyer' | 'supplier' | 'all';
  search: string | null;
  offset: number;
  limit: number;
}

const MATCHES_CTE = `
  cp AS (
    SELECT m.source_key, m.deleted, m.missing_in_source_at IS NOT NULL AS missing, m.data,
           ${normalizedName("m.data->>'Description'")} AS n
      FROM onec_etl_mirror_rows m
     WHERE m.source_id = $1 AND m.entity_code = 'counterparties' AND NOT COALESCE((m.data->>'IsFolder')::boolean, false)),
  cl AS (SELECT client_id, client_name::text AS name, ref_key_1c, ${normalizedName('client_name::text')} AS n FROM clients),
  sp AS (SELECT supplier_id, supplier_name AS name, ref_key_1c, ${normalizedName('supplier_name')} AS n FROM suppliers),
  ph AS (SELECT m.data->>'Ref_Key' AS source_key, ${normalizedPhone("m.data->>'Представление'")} AS p
           FROM onec_etl_mirror_rows m
           -- Phones are personal data: a revoked or expired snapshot is not compared either.
           ${livePersonalSnapshotJoin('m')}
          WHERE m.source_id = $1 AND m.entity_code = 'counterparty_phones' AND NOT m.deleted AND m.missing_in_source_at IS NULL),
  cph AS (SELECT DISTINCT client_id, ${normalizedPhone('phone_number')} AS p FROM client_phones),
  hits AS (
    SELECT cp.source_key, 'client' AS kind, cl.client_id::bigint AS id, cl.name, 'ref_key' AS by
      FROM cp JOIN cl ON cl.ref_key_1c::text = cp.source_key
    UNION ALL
    SELECT cp.source_key, 'client', cl.client_id, cl.name, 'name' FROM cp JOIN cl ON cl.n = cp.n AND cp.n <> ''
    UNION ALL
    SELECT ph.source_key, 'client', cl.client_id, cl.name, 'phone'
      FROM ph JOIN cph ON cph.p = ph.p AND length(ph.p) = 10 JOIN cl ON cl.client_id = cph.client_id
    UNION ALL
    SELECT cp.source_key, 'supplier', sp.supplier_id, sp.name, 'ref_key' FROM cp JOIN sp ON sp.ref_key_1c::text = cp.source_key
    UNION ALL
    SELECT cp.source_key, 'supplier', sp.supplier_id, sp.name, 'name' FROM cp JOIN sp ON sp.n = cp.n AND cp.n <> ''),
  cand AS (
    SELECT source_key, kind, id, max(name) AS name, array_agg(DISTINCT by ORDER BY by) AS by
      FROM hits GROUP BY source_key, kind, id),
  agg AS (
    SELECT source_key,
           count(*) FILTER (WHERE kind = 'client') AS clients,
           count(*) FILTER (WHERE kind = 'supplier') AS suppliers,
           jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'name', name, 'by', by) ORDER BY kind, name) AS matches
      FROM cand GROUP BY source_key),
  rowset AS (
    SELECT cp.*, COALESCE(agg.matches, '[]'::jsonb) AS matches,
           CASE WHEN COALESCE(agg.clients, 0) > 1 OR COALESCE(agg.suppliers, 0) > 1 THEN 'ambiguous'
                WHEN COALESCE(agg.clients, 0) + COALESCE(agg.suppliers, 0) > 0 THEN 'matched'
                ELSE 'unmatched' END AS status,
           COALESCE((cp.data->>'Покупатель')::boolean, false) AS buyer,
           COALESCE((cp.data->>'Поставщик')::boolean, false) AS supplier
      FROM cp LEFT JOIN agg ON agg.source_key = cp.source_key)`;

@Injectable()
export class PgOnecMatchingRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async counterpartySummary(sourceId: number): Promise<QueryResultRow> {
    const { rows } = await this.database.query(
      `WITH ${MATCHES_CTE}
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE buyer)::int AS buyers,
              count(*) FILTER (WHERE supplier)::int AS suppliers,
              count(*) FILTER (WHERE status = 'matched')::int AS matched,
              count(*) FILTER (WHERE status = 'ambiguous')::int AS ambiguous,
              count(*) FILTER (WHERE status = 'unmatched')::int AS unmatched,
              count(*) FILTER (WHERE matches @> '[{"by":["ref_key"]}]')::int AS by_ref_key,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(matches) e WHERE e->'by' ? 'name'))::int AS by_name,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(matches) e WHERE e->'by' ? 'phone'))::int AS by_phone
         FROM rowset`,
      [sourceId],
    );
    return rows[0];
  }

  private static readonly FILTER = `($2 = 'all' OR r.status = $2)
          AND ($3 = 'all' OR ($3 = 'buyer' AND r.buyer) OR ($3 = 'supplier' AND r.supplier))
          AND ($4::text IS NULL OR r.data->>'Description' ILIKE $4 OR r.data->>'Code' ILIKE $4
               OR r.data->>'ИдентификационныйНомер' ILIKE $4)`;

  private static searchPattern(search: string | null): string | null {
    return search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  }

  async counterparties(filter: CounterpartyMatchFilter): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `WITH ${MATCHES_CTE}
       SELECT r.source_key, r.deleted, r.missing, r.status, r.buyer, r.supplier, r.matches,
              r.data->>'Code' AS code, r.data->>'Description' AS name, r.data->>'НаименованиеПолное' AS full_name,
              r.data->>'ИдентификационныйНомер' AS bin, (r.data->>'ИдентификационныйНомерВведенКорректно')::boolean AS bin_valid
         FROM rowset r
        WHERE ${PgOnecMatchingRepository.FILTER}
        ORDER BY r.data->>'Description', r.source_key
        LIMIT $5 OFFSET $6`,
      [filter.sourceId, filter.status, filter.role, PgOnecMatchingRepository.searchPattern(filter.search), filter.limit, filter.offset],
    );
    return rows;
  }

  /** Filtered row count, independent of the page (an empty page past the end still reports the total). */
  async counterpartyCount(filter: CounterpartyMatchFilter): Promise<number> {
    const { rows } = await this.database.query(
      `WITH ${MATCHES_CTE}
       SELECT count(*)::int AS total FROM rowset r WHERE ${PgOnecMatchingRepository.FILTER}`,
      [filter.sourceId, filter.status, filter.role, PgOnecMatchingRepository.searchPattern(filter.search)],
    );
    return Number(rows[0].total);
  }

  /** pg_trgm is optional: similar-name suggestions only where the extension exists. */
  async trigramAvailable(): Promise<boolean> {
    const { rows } = await this.database.query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok`);
    return rows[0]?.ok === true;
  }

  /** Up to 3 ERP clients/suppliers with a similar normalized name, for rows that matched nothing. */
  async suggestions(names: string[]): Promise<Map<string, QueryResultRow[]>> {
    const result = new Map<string, QueryResultRow[]>();
    if (names.length === 0) return result;
    const { rows } = await this.database.query(
      `WITH q AS (SELECT DISTINCT unnest($1::text[]) AS name),
            qn AS (SELECT name, ${normalizedName('name')} AS n FROM q),
            erp AS (SELECT 'client' AS kind, client_id::bigint AS id, client_name::text AS name, ${normalizedName('client_name::text')} AS n FROM clients
                    UNION ALL
                    SELECT 'supplier', supplier_id, supplier_name, ${normalizedName('supplier_name')} FROM suppliers)
       SELECT qn.name AS query, s.kind, s.id, s.name, s.score
         FROM qn CROSS JOIN LATERAL (
           SELECT erp.kind, erp.id, erp.name, similarity(erp.n, qn.n) AS score FROM erp
            WHERE qn.n <> '' AND similarity(erp.n, qn.n) >= 0.45
            ORDER BY score DESC, erp.name LIMIT 3) s`,
      [names],
    );
    for (const row of rows) {
      const list = result.get(row.query) ?? [];
      list.push(row);
      result.set(row.query, list);
    }
    return result;
  }

  /** Items (not folders) per 1C category × item type, with price/stock presence — the basis of E4 rules. */
  async itemDistribution(sourceId: number): Promise<QueryResultRow[]> {
    const { rows } = await this.database.query(
      `WITH it AS (
         SELECT m.source_key, m.deleted, m.missing_in_source_at IS NOT NULL AS missing, m.data->>'КатегорияНоменклатуры_Key' AS category_key,
                COALESCE(NULLIF(m.data->>'ТипНоменклатуры', ''), '—') AS item_type
           FROM onec_etl_mirror_rows m
          WHERE m.source_id = $1 AND m.entity_code = 'items' AND NOT COALESCE((m.data->>'IsFolder')::boolean, false)),
       -- Only rows present in the latest full read count as current prices/stock.
       priced AS (SELECT DISTINCT data->>'Номенклатура_Key' AS k FROM onec_etl_mirror_rows
                   WHERE source_id = $1 AND entity_code = 'item_prices' AND missing_in_source_at IS NULL AND NOT deleted),
       stocked AS (SELECT DISTINCT data->>'Номенклатура_Key' AS k FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = 'stock_balances')
       SELECT it.category_key, c.data->>'Description' AS category_name, c.data->>'ТипНоменклатурыПоУмолчанию' AS category_default_type,
              it.item_type, count(*) FILTER (WHERE NOT it.missing)::int AS total, count(*) FILTER (WHERE it.deleted AND NOT it.missing)::int AS deleted,
              count(*) FILTER (WHERE it.missing)::int AS missing,
              count(*) FILTER (WHERE priced.k IS NOT NULL AND NOT it.missing)::int AS with_price,
              count(*) FILTER (WHERE stocked.k IS NOT NULL AND NOT it.missing)::int AS with_stock
         FROM it
         LEFT JOIN onec_etl_mirror_rows c ON c.source_id = $1 AND c.entity_code = 'item_categories' AND c.source_key = it.category_key
         LEFT JOIN priced ON priced.k = it.source_key
         LEFT JOIN stocked ON stocked.k = it.source_key
        GROUP BY 1, 2, 3, 4
        ORDER BY sum(count(*)) OVER (PARTITION BY it.category_key) DESC, category_name NULLS LAST, total DESC`,
      [sourceId],
    );
    return rows;
  }
}
