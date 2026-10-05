import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';

const SOURCE = 'erp_party_contacts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SupplierCounterparty {
  /** 1C counterparty ref key (uuid, lower case; the procurement key is `c:<refKey1c>`). */
  refKey1c: string;
  name: string;
  /** Marked as a supplier in 1C (null when the source does not say). */
  isSupplier: boolean | null;
  /** The supplier of the directory already linked to this counterparty. */
  supplierId: number | null;
  supplierName: string | null;
}

export interface SupplierLink { supplierId: number; supplierName: string; refKey1c: string | null; counterpartyName: string | null }

export function parseRefKey1c(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID.test(key)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный ключ контрагента 1С');
  return key;
}

/**
 * The link of a supplier of the directory to a 1C counterparty (`suppliers.ref_key_1c`). The key drives the
 * 1C documents loader (it sets onec_documents.supplier_id on its next pass — a one-off wave of document
 * revisions per counterparty), so it is changed only here: compare-and-swap on the previous key, audited.
 * Procurement keys (`c:<ref>`) and resource_suppliers are never touched.
 */
@Injectable()
export class SupplierCounterpartyRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Counterparties to choose from: the 1C mirror when it is there (not a folder, not marked for deletion, still
   * in the source), else the counterparties procurement has seen in 1C documents, else nothing.
   */
  async counterparties(search: string | null, limit = 50, client: DatabaseClient = this.database): Promise<SupplierCounterparty[]> {
    const like = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const source = await this.source(client);
    if (!source) return [];
    const rows = (await client.query<{ ref: string; name: string; is_supplier: boolean | null; supplier_id: string | null; supplier_name: string | null }>(
      `WITH cp AS (${source}) SELECT cp.ref, cp.name, cp.is_supplier, s.supplier_id, s.supplier_name
         FROM cp LEFT JOIN suppliers s ON lower(s.ref_key_1c::text) = cp.ref
        WHERE $1::text IS NULL OR cp.name ILIKE $1 ESCAPE '\\'
        ORDER BY cp.is_supplier DESC NULLS LAST, cp.name, cp.ref LIMIT $2`, [like, Math.min(Math.max(limit, 1), 200)])).rows;
    return rows.map(toCounterparty);
  }

  async link(supplierId: number, client: DatabaseClient = this.database): Promise<SupplierLink> {
    const row = (await client.query<{ supplier_name: string; ref: string | null }>(
      'SELECT supplier_name, lower(ref_key_1c::text) AS ref FROM suppliers WHERE supplier_id = $1', [supplierId])).rows[0];
    if (!row) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'Поставщик не найден');
    return { supplierId, supplierName: row.supplier_name, refKey1c: row.ref, counterpartyName: row.ref ? await this.name(client, row.ref) : null };
  }

  /**
   * Links, relinks or unlinks. `expected` is the key the caller saw: another key under the lock is a conflict
   * (nobody's link is overwritten blindly); the key already being the new one is a repeat — no second audit.
   */
  async setLink(supplierId: number, refKey1c: string | null, expected: string | null, actor: CurrentUser, requestId: string): Promise<SupplierLink> {
    return this.database.transaction(async (tx) => {
      const row = (await tx.query<{ ref: string | null }>(
        'SELECT lower(ref_key_1c::text) AS ref FROM suppliers WHERE supplier_id = $1 FOR NO KEY UPDATE', [supplierId])).rows[0];
      if (!row) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'Поставщик не найден');
      if (row.ref === refKey1c) return this.link(supplierId, tx);
      if (row.ref !== expected) {
        throw new ApiError(409, 'SUPPLIER_COUNTERPARTY_CONFLICT', 'Привязка к контрагенту 1С уже изменена; обновите страницу', { refKey1c: row.ref });
      }
      const counterpartyName = refKey1c ? await this.requireKnown(tx, refKey1c) : null;
      await tx.query('UPDATE suppliers SET ref_key_1c = $2::uuid, edited_by = $3 WHERE supplier_id = $1', [supplierId, refKey1c, Number(actor.id)]);
      await auditService.record(tx, {
        event: refKey1c ? 'supplier.counterparty_linked' : 'supplier.counterparty_unlinked', entityType: 'supplier', entityId: supplierId,
        actorUserId: Number(actor.id), actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        relatedEntities: [{ entityType: 'supplier', entityId: supplierId }],
        before: { refKey1c: row.ref }, after: { refKey1c },
        metadata: { counterpartyName },
      });
      return this.link(supplierId, tx);
    }).catch((error: unknown) => { throw taken(error); });
  }

  /**
   * Adds a counterparty to the directory: a supplier named after it with its key. Idempotent by the key — an
   * existing supplier with it is returned and nothing is audited twice.
   */
  async createFromCounterparty(refKey1c: string, actor: CurrentUser, requestId: string): Promise<SupplierLink & { created: boolean }> {
    return this.database.transaction(async (tx) => {
      // Two creations of one counterparty wait for each other here; the unique index is the last line of defence.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`supplier-counterparty:${refKey1c}`]);
      const existing = (await tx.query<{ supplier_id: string }>('SELECT supplier_id FROM suppliers WHERE lower(ref_key_1c::text) = $1', [refKey1c])).rows[0];
      if (existing) return { ...(await this.link(Number(existing.supplier_id), tx)), created: false };
      const name = await this.requireKnown(tx, refKey1c);
      // No 1C data at all (the module is not installed): there is no name to create a supplier from.
      if (name === null) throw new ApiError(422, 'SUPPLIER_COUNTERPARTY_UNKNOWN', 'Данные контрагентов 1С не загружены');
      const sameName = (await tx.query<{ supplier_id: string }>('SELECT supplier_id FROM suppliers WHERE lower(btrim(supplier_name)) = lower(btrim($1))', [name])).rows[0];
      if (sameName) {
        throw new ApiError(409, 'SUPPLIER_NAME_TAKEN', 'Поставщик с таким названием уже есть в справочнике — привяжите его к контрагенту 1С',
          { supplierId: Number(sameName.supplier_id) });
      }
      const actorId = Number(actor.id);
      const supplierId = Number((await tx.query<{ supplier_id: string }>(`INSERT INTO suppliers (supplier_name, ref_key_1c, is_active, created_by, edited_by)
        VALUES ($1, $2::uuid, true, $3, $3) RETURNING supplier_id`, [name.slice(0, 250), refKey1c, actorId])).rows[0].supplier_id);
      await auditService.record(tx, {
        event: 'supplier.created_from_counterparty', entityType: 'supplier', entityId: supplierId,
        actorUserId: actorId, actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        relatedEntities: [{ entityType: 'supplier', entityId: supplierId }],
        after: { supplierName: name, refKey1c },
      });
      return { ...(await this.link(supplierId, tx)), created: true };
    }).catch((error: unknown) => { throw taken(error); });
  }

  /** A key that no source knows is refused when a source exists (a typo would silently link nothing). */
  private async requireKnown(tx: TransactionClient, refKey1c: string): Promise<string | null> {
    if (!(await this.source(tx))) return null;
    const name = await this.name(tx, refKey1c);
    if (name === null) throw new ApiError(422, 'SUPPLIER_COUNTERPARTY_UNKNOWN', 'Такого контрагента 1С нет в загруженных данных');
    return name;
  }

  private async name(client: DatabaseClient, refKey1c: string): Promise<string | null> {
    const source = await this.source(client);
    if (!source) return null;
    return (await client.query<{ name: string }>(`WITH cp AS (${source}) SELECT name FROM cp WHERE ref = $1`, [refKey1c])).rows[0]?.name ?? null;
  }

  /** SQL of the counterparty source (ref, name, is_supplier), or null when neither table exists (1C module not installed). */
  private async source(client: DatabaseClient): Promise<string | null> {
    const tables = (await client.query<{ mirror: boolean; procurement: boolean }>(
      `SELECT to_regclass('onec_etl_mirror_rows') IS NOT NULL AS mirror, to_regclass('resource_suppliers') IS NOT NULL AS procurement`)).rows[0];
    if (tables?.mirror) {
      const filled = (await client.query(`SELECT 1 FROM onec_etl_mirror_rows WHERE entity_code = 'counterparties' LIMIT 1`)).rows.length > 0;
      if (filled) {
        return `SELECT DISTINCT ON (lower(m.source_key)) lower(m.source_key) AS ref,
            COALESCE(NULLIF(btrim(m.data->>'Description'), ''), m.source_key) AS name, (m.data->>'Поставщик') = 'true' AS is_supplier
          FROM onec_etl_mirror_rows m
         WHERE m.entity_code = 'counterparties' AND NOT m.deleted AND m.missing_in_source_at IS NULL
           AND COALESCE(m.data->>'IsFolder', 'false') <> 'true' AND COALESCE(m.data->>'DeletionMark', 'false') <> 'true'
           AND lower(m.source_key) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         ORDER BY lower(m.source_key), m.source_id`;
      }
    }
    if (tables?.procurement) {
      return `SELECT lower(substr(rs.supplier_key, 3)) AS ref, max(rs.counterparty_name) AS name, NULL::boolean AS is_supplier
          FROM resource_suppliers rs
         WHERE rs.supplier_key ~ '^c:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         GROUP BY lower(substr(rs.supplier_key, 3))`;
    }
    return null;
  }
}

function toCounterparty(row: { ref: string; name: string; is_supplier: boolean | null; supplier_id: string | null; supplier_name: string | null }): SupplierCounterparty {
  return { refKey1c: row.ref, name: row.name, isSupplier: row.is_supplier, supplierId: row.supplier_id === null ? null : Number(row.supplier_id), supplierName: row.supplier_name };
}

/** The unique index on suppliers.ref_key_1c: the counterparty already belongs to another supplier. */
function taken(error: unknown): unknown {
  const record = error as { code?: string; constraint?: string } | null;
  if (record?.code === '23505' && String(record.constraint ?? '').includes('ref_key_1c')) {
    return new ApiError(409, 'SUPPLIER_COUNTERPARTY_TAKEN', 'Этот контрагент 1С уже привязан к другому поставщику');
  }
  if (record?.code === '23505' && String(record.constraint ?? '').includes('supplier_name')) {
    return new ApiError(409, 'SUPPLIER_NAME_TAKEN', 'Поставщик с таким названием уже есть в справочнике');
  }
  // Anything else (e.g. a primary key clash after a sequence drift) is a real failure, not a name conflict.
  return error;
}
