import type { DatabaseClient } from '../../../database/database.types';
import type { OnecStockLinks, SheetLink } from '../domain/onec-stock-groups';

export interface StockWarehouseRow {
  warehouseId: number;
  name: string;
  refKey1c: string | null;
}

export interface ErpFilmBalanceRow {
  filmId: number;
  filmName: string;
  vendorName: string | null;
  quantity: number;
}

/** Типы материалов без своей вкладки: заглушка «нд» справочника. */
const HIDDEN_MATERIAL_TYPE = /^\s*нд\s*$/i;

/**
 * Чтения экрана «Остатки на складах». Все методы — в транзакции вызывающего (REPEATABLE READ
 * READ ONLY): склад, учёт плёнки ERP и связи с 1С должны быть одного снимка с зеркалом.
 */
export class PgWarehouseStockRepository {
  async warehouse(client: DatabaseClient, warehouseId: number): Promise<StockWarehouseRow | null> {
    const { rows } = await client.query<{ warehouse_id: number; warehouse_name: string; ref_key_1c: string | null }>(
      'SELECT warehouse_id, warehouse_name, ref_key_1c::text AS ref_key_1c FROM warehouses WHERE warehouse_id = $1',
      [warehouseId],
    );
    const row = rows[0];
    return row ? { warehouseId: Number(row.warehouse_id), name: row.warehouse_name, refKey1c: row.ref_key_1c?.toLowerCase() ?? null } : null;
  }

  /** Все остатки плёнки ERP склада (как «Остатки плёнки»; объём ограничен справочником плёнок). */
  async filmBalances(client: DatabaseClient, warehouseId: number): Promise<ErpFilmBalanceRow[]> {
    const { rows } = await client.query<{ film_id: string; film_name: string; vendor_name: string | null; quantity: string }>(
      `SELECT b.film_id, f.film_name, v.vendor_name, b.quantity
         FROM stock_balances b
         JOIN films f ON f.film_id = b.film_id
         LEFT JOIN vendors v ON v.vendor_id = f.vendor_id
        WHERE b.warehouse_id = $1
        ORDER BY f.film_name, b.film_id`,
      [warehouseId],
    );
    return rows.map((row) => ({ filmId: Number(row.film_id), filmName: row.film_name, vendorName: row.vendor_name, quantity: Number(row.quantity) }));
  }

  /**
   * Связи позиций 1С со справочниками ERP по ключу: плёнки (основные и дубли), активные листовые
   * материалы (несколько на ключ — минимальный id, флаг неоднозначности), позиции, принятые импортом
   * каталога плёнок этого источника. `itemKeys` — валидные GUID (reader).
   */
  async links(client: DatabaseClient, sourceId: number, itemKeys: readonly string[]): Promise<{ links: OnecStockLinks; materialTypeNames: Map<number, string> }> {
    const keys = [...new Set(itemKeys.map((key) => key.toLowerCase()))];
    // Последовательно: один клиент транзакции.
    const films = await       client.query<{ key: string }>(
        'SELECT DISTINCT ref_key_1c::text AS key FROM films WHERE ref_key_1c = ANY($1::uuid[])',
        [keys],
      );
    const sheets = await client.query<{ key: string; sheet_material_type_id: string; material_type_id: number | null; links: string }>(
        `SELECT DISTINCT ON (ref_key_1c) ref_key_1c::text AS key, sheet_material_type_id, material_type_id,
                count(*) OVER (PARTITION BY ref_key_1c) AS links
           FROM sheet_material_types
          WHERE is_active AND ref_key_1c = ANY($1::uuid[])
          ORDER BY ref_key_1c, sheet_material_type_id`,
        [keys],
      );
    const types = await client.query<{ material_type_id: number; material_type_name: string }>(
        'SELECT material_type_id, material_type_name FROM material_types',
      );
    // Признак плёнки по позиции: строка, принятая обработчиком каталога плёнок (категория и единица
    // проверены им), в непогашенном пакете этого источника. Пакет чужой категории даёт только skipped.
    const catalogFilms = await client.query<{ key: string }>(
      `SELECT DISTINCT lower(r.onec_source_key) AS key
         FROM catalog_import_rows r
         JOIN catalog_import_batches b ON b.batch_id = r.batch_id
        WHERE b.source_kind = 'onec_mirror' AND b.reference_kind = 'films' AND b.onec_source_id = $1
          AND b.status IN ('draft', 'applied') AND r.row_status = 'ok'
          AND lower(r.onec_source_key) = ANY($2::text[])`,
      [sourceId, keys],
    );
    const sheetByKey = new Map<string, SheetLink>(sheets.rows.map((row) => [row.key.toLowerCase(), {
      sheetMaterialTypeId: Number(row.sheet_material_type_id),
      materialTypeId: row.material_type_id === null ? null : Number(row.material_type_id),
      ambiguous: Number(row.links) > 1,
    }]));
    const materialTypeNames = new Map(types.rows.map((row) => [Number(row.material_type_id), row.material_type_name]));
    return {
      links: {
        filmKeys: new Set(films.rows.map((row) => row.key.toLowerCase())),
        sheetByKey,
        hiddenMaterialTypeIds: new Set(types.rows.filter((row) => HIDDEN_MATERIAL_TYPE.test(row.material_type_name)).map((row) => Number(row.material_type_id))),
        filmCatalogItemKeys: new Set(catalogFilms.rows.map((row) => row.key)),
      },
      materialTypeNames,
    };
  }
}
