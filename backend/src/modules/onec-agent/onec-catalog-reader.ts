import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import { ApiError } from '../../common/errors/api-error';
import { OnecRuntimeConfigService } from './onec-runtime-config.service';

export interface OnecCatalogItem {
  sourceKey: string;
  rowHash: string;
  description: string;
  nomenclatureType: string | null;
  unitName: string | null;
  categoryName: string | null;
  deletionMark: boolean;
  isFolder: boolean;
}
/** Склад 1С из зеркала (справочник «Структурные единицы», только тип «Склад»). */
export interface OnecWarehouse {
  sourceId: number;
  refKey: string;
  code: string | null;
  name: string;
}
/**
 * Состояние снимка остатков 1С источника. `snapshotVersion` — as-of последнего ПРИМЕНЁННОГО
 * verified-снимка (отклонённый его не двигает); `revoked` — отзыв пары (источник, сущность).
 */
export interface OnecStockState {
  sourceId: number;
  /** Есть применённый снимок (`snapshot_version`); пустой применённый снимок — тоже загружен. */
  loaded: boolean;
  snapshotVersion: string | null;
  rejectedReason: string | null;
  completeness: string | null;
  revoked: { stockBalances: boolean; items: boolean; units: boolean; itemCategories: boolean };
}
/** Остаток 1С позиции на складе: сумма по организациям/характеристикам/партиям/ячейкам. */
export interface OnecStockBalance {
  itemRefKey: string;
  code: string | null;
  name: string | null;
  unitName: string | null;
  categoryKey: string | null;
  categoryName: string | null;
  quantity: number;
}
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class OnecCatalogReader {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OnecRuntimeConfigService)
    private readonly runtime: OnecRuntimeConfigService
  ) {}
  /** `client` — текущая транзакция вызывающего (не брать второе соединение пула внутри неё). */
  private async available(client: DatabaseClient = this.db): Promise<void> {
    if (!this.runtime.get().enabled)
      throw new ApiError(
        409,
        'ONEC_MIRROR_UNAVAILABLE',
        'Зеркало 1С недоступно'
      );
    const result = await client.query<{ ready: boolean }>(
      `SELECT to_regclass('public.onec_sources') IS NOT NULL AND to_regclass('public.onec_etl_mirror_rows') IS NOT NULL AS ready`
    );
    if (!result.rows[0]?.ready)
      throw new ApiError(
        409,
        'ONEC_MIRROR_UNAVAILABLE',
        'Зеркало 1С недоступно'
      );
  }
  async listSources(): Promise<Array<{ sourceId: number; name: string }>> {
    await this.available();
    const { rows } = await this.db.query(
      `SELECT source_id,display_name FROM onec_sources ORDER BY display_name,source_id`
    );
    if (rows.length === 0)
      throw new ApiError(409, 'ONEC_MIRROR_UNAVAILABLE', 'Нет источников 1С');
    return rows.map((row) => ({
      sourceId: Number(row.source_id),
      name: String(row.display_name),
    }));
  }
  async listItemCategories(
    sourceId: number
  ): Promise<Array<{ key: string; name: string; itemsCount: number }>> {
    await this.available();
    const { rows } = await this.db.query(
      `SELECT c.source_key AS key,COALESCE(c.data->>'Description',c.data->>'Представление',c.source_key) AS name,
      count(i.source_key)::int AS items_count FROM onec_etl_mirror_rows c LEFT JOIN onec_etl_mirror_rows i
      ON i.source_id=c.source_id AND i.entity_code='items' AND i.data->>'КатегорияНоменклатуры_Key'=c.source_key AND NOT i.deleted AND i.missing_in_source_at IS NULL AND COALESCE((i.data->>'IsFolder')::boolean,false)=false AND COALESCE((i.data->>'DeletionMark')::boolean,false)=false
      WHERE c.source_id=$1 AND c.entity_code='item_categories' AND NOT c.deleted AND c.missing_in_source_at IS NULL
      GROUP BY c.source_key,c.data ORDER BY name`,
      [sourceId]
    );
    if (rows.length === 0) {
      const source = await this.db.query(
        `SELECT 1 FROM onec_sources WHERE source_id=$1`,
        [sourceId]
      );
      if (!source.rows.length)
        throw new ApiError(
          409,
          'ONEC_MIRROR_UNAVAILABLE',
          'Источник 1С недоступен'
        );
    }
    return rows.map((row) => ({
      key: String(row.key),
      name: String(row.name),
      itemsCount: Number(row.items_count),
    }));
  }
  async listCatalogItems(
    sourceId: number,
    categoryKey: string
  ): Promise<OnecCatalogItem[]> {
    await this.available();
    const { rows } = await this.db.query(
      `SELECT i.source_key,i.row_hash,i.data,
      COALESCE(u.data->>'Description',u.data->>'Представление') AS unit_name,
      COALESCE(c.data->>'Description',c.data->>'Представление') AS category_name
      FROM onec_etl_mirror_rows i LEFT JOIN onec_etl_mirror_rows u ON u.source_id=i.source_id AND u.entity_code='units' AND u.source_key=i.data->>'ЕдиницаИзмерения_Key' AND NOT u.deleted AND u.missing_in_source_at IS NULL
      LEFT JOIN onec_etl_mirror_rows c ON c.source_id=i.source_id AND c.entity_code='item_categories' AND c.source_key=i.data->>'КатегорияНоменклатуры_Key' AND NOT c.deleted AND c.missing_in_source_at IS NULL
      WHERE i.source_id=$1 AND i.entity_code='items' AND i.data->>'КатегорияНоменклатуры_Key'=$2 AND NOT i.deleted AND i.missing_in_source_at IS NULL ORDER BY i.source_key`,
      [sourceId, categoryKey]
    );
    if (rows.length === 0) {
      const source = await this.db.query(
        `SELECT 1 FROM onec_sources WHERE source_id=$1`,
        [sourceId]
      );
      const category = await this.db.query(
        `SELECT 1 FROM onec_etl_mirror_rows WHERE source_id=$1 AND entity_code='item_categories' AND source_key=$2 AND NOT deleted AND missing_in_source_at IS NULL`,
        [sourceId, categoryKey]
      );
      if (!source.rows.length || !category.rows.length)
        throw new ApiError(
          409,
          'ONEC_MIRROR_UNAVAILABLE',
          'Источник или категория зеркала недоступны'
        );
    }
    return rows.map((row) => ({
      sourceKey: String(row.source_key),
      rowHash: String(row.row_hash),
      description: String(row.data.Description ?? ''),
      nomenclatureType:
        row.data.ТипНоменклатуры == null
          ? null
          : String(row.data.ТипНоменклатуры),
      unitName: row.unit_name == null ? null : String(row.unit_name),
      categoryName:
        row.category_name == null ? null : String(row.category_name),
      deletionMark: row.data.DeletionMark === true,
      isFolder: row.data.IsFolder === true,
    }));
  }

  async findRefKeysByDescription(
    description: string,
    categoryName: string | null
  ): Promise<string[]> {
    await this.available();
    const { rows } = await this.db.query(
      `SELECT i.source_key FROM onec_etl_mirror_rows i JOIN onec_etl_mirror_rows c ON c.source_id=i.source_id AND c.entity_code='item_categories' AND c.source_key=i.data->>'КатегорияНоменклатуры_Key' AND NOT c.deleted AND c.missing_in_source_at IS NULL WHERE i.entity_code='items' AND NOT i.deleted AND i.missing_in_source_at IS NULL AND COALESCE((i.data->>'IsFolder')::boolean,false)=false AND COALESCE((i.data->>'DeletionMark')::boolean,false)=false AND lower(regexp_replace(trim(i.data->>'Description'),'\\s+',' ','g'))=lower(regexp_replace(trim($1),'\\s+',' ','g')) AND lower(regexp_replace(trim(COALESCE(c.data->>'Description',c.data->>'Представление','')),'\\s+',' ','g'))=lower(regexp_replace(trim(COALESCE($2,'')),'\\s+',' ','g'))`,
      [description, categoryName]
    );
    return rows.map((row) => String(row.source_key));
  }

  /**
   * Действующие склады 1С всех источников: тип «Склад», не помечены на удаление,
   * не пропали из последней полной выгрузки. Недоступное зеркало — 409 ONEC_MIRROR_UNAVAILABLE.
   * Внутри транзакции передавать её клиент.
   */
  /**
   * Склады 1С для записи в справочник ERP (синхронизация): сначала `onec_etl_entity_state`
   * склада каждого источника `FOR SHARE` (в порядке source_id), затем копия — только этих
   * источников, в той же транзакции. `complete`, отзыв и rebaseline берут эту строку
   * `FOR UPDATE`/`FOR NO KEY UPDATE`: пока транзакция вызывающего открыта, прочитанная копия
   * не меняется. Источник без строки состояния в этот вызов не входит. `sourceIds` сужает набор.
   */
  async lockAndListWarehouses(tx: DatabaseClient, sourceIds?: readonly number[]): Promise<OnecWarehouse[]> {
    await this.available(tx);
    const locked = await tx.query<{ source_id: string }>(
      `SELECT source_id FROM onec_etl_entity_state
        WHERE entity_code = 'warehouses' AND ($1::bigint[] IS NULL OR source_id = ANY($1::bigint[]))
        ORDER BY source_id FOR SHARE`,
      [sourceIds ? [...sourceIds] : null],
    );
    const ids = locked.rows.map((row) => Number(row.source_id));
    if (ids.length === 0) return [];
    return this.listWarehouses(tx, ids);
  }

  /** Источники, по которым выгружалась сущность (часовые проходы потребителей копии). */
  async entitySourceIds(entityCode: string, client: DatabaseClient = this.db): Promise<number[]> {
    await this.available(client);
    const { rows } = await client.query<{ source_id: string }>(
      'SELECT source_id FROM onec_etl_entity_state WHERE entity_code = $1 ORDER BY source_id',
      [entityCode],
    );
    return rows.map((row) => Number(row.source_id));
  }

  /**
   * Ключи строк копии документа в хронологическом порядке (`Date`, `Number`, ключ) — порядок первого прохода
   * загрузчика документов (реестр поставщиков: «первым» должен быть самый ранний документ).
   */
  async orderedDocumentKeys(sourceId: number, entityCode: string, client: DatabaseClient = this.db): Promise<string[]> {
    await this.available(client);
    const { rows } = await client.query<{ source_key: string }>(
      `SELECT source_key FROM onec_etl_mirror_rows
        WHERE source_id = $1 AND entity_code = $2
        ORDER BY data->>'Date', data->>'Number', source_key`,
      [sourceId, entityCode],
    );
    return rows.map((row) => row.source_key);
  }

  /**
   * `onec_etl_entity_state` сущности `FOR SHARE` в транзакции вызывающего: пока она открыта, `complete`, отзыв и
   * rebaseline этой сущности ждут. false — сущность ещё не выгружалась.
   */
  async lockEntityShare(tx: DatabaseClient, sourceId: number, entityCode: string): Promise<boolean> {
    const { rows } = await tx.query(
      'SELECT 1 FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2 FOR SHARE',
      [sourceId, entityCode],
    );
    return rows.length > 0;
  }

  /** Строки копии по ключам (документ или справочные значения): данные, удаление, пропажа из выгрузки. */
  async mirrorRows(
    client: DatabaseClient,
    sourceId: number,
    entityCode: string,
    keys: readonly string[],
  ): Promise<Map<string, { data: Record<string, unknown>; deleted: boolean; missing: boolean }>> {
    const result = new Map<string, { data: Record<string, unknown>; deleted: boolean; missing: boolean }>();
    if (keys.length === 0) return result;
    const { rows } = await client.query<{ source_key: string; data: Record<string, unknown>; deleted: boolean; missing: boolean }>(
      `SELECT source_key, data, deleted, missing_in_source_at IS NOT NULL AS missing
         FROM onec_etl_mirror_rows
        WHERE source_id = $1 AND entity_code = $2 AND source_key = ANY($3::text[])`,
      [sourceId, entityCode, [...new Set(keys)]],
    );
    for (const row of rows) result.set(row.source_key, { data: row.data, deleted: row.deleted, missing: row.missing });
    return result;
  }

  /** Данные всех строк сущности источника (справочники для потребителей копии: единицы, номенклатура, контрагенты). */
  async entityData(sourceId: number, entityCode: string, client: DatabaseClient = this.db): Promise<Map<string, Record<string, unknown>>> {
    await this.available(client);
    const { rows } = await client.query<{ source_key: string; data: Record<string, unknown> }>(
      'SELECT source_key, data FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2',
      [sourceId, entityCode],
    );
    return new Map(rows.map((row) => [row.source_key.toLowerCase(), row.data]));
  }

  /** Все источники, по которым выгружались склады (часовой проход автосинхронизации). */
  async warehouseSourceIds(client: DatabaseClient = this.db): Promise<number[]> {
    await this.available(client);
    const { rows } = await client.query<{ source_id: string }>(
      `SELECT source_id FROM onec_etl_entity_state WHERE entity_code = 'warehouses' ORDER BY source_id`,
    );
    return rows.map((row) => Number(row.source_id));
  }

  /**
   * Состояние снимка `stock_balances` и отзыв справочников источника. Для согласованности с
   * `stockBalances` читать в одной транзакции REPEATABLE READ READ ONLY вызывающего (снимок
   * применяется одной транзакцией: строки + состояние). Без блокировок.
   */
  async stockState(sourceId: number, client: DatabaseClient = this.db): Promise<OnecStockState> {
    await this.available(client);
    const { rows } = await client.query<{
      entity_code: string; revoked: boolean; snapshot_version: Date | string | null;
      snapshot_rejected_reason: string | null; last_completeness: string | null;
    }>(
      `SELECT entity_code, revoked_at IS NOT NULL AS revoked, snapshot_version, snapshot_rejected_reason, last_completeness
         FROM onec_etl_entity_state
        WHERE source_id = $1 AND entity_code IN ('stock_balances', 'items', 'units', 'item_categories')`,
      [sourceId],
    );
    const byEntity = new Map(rows.map((row) => [row.entity_code, row]));
    const stock = byEntity.get('stock_balances');
    const version = stock?.snapshot_version ?? null;
    return {
      sourceId,
      // Строка состояния появляется до первого применённого снимка (и после отклонённого первого):
      // загруженным считается только применённый снимок.
      loaded: stock?.snapshot_version != null,
      snapshotVersion: version === null ? null : new Date(version).toISOString(),
      rejectedReason: stock?.snapshot_rejected_reason ?? null,
      completeness: stock?.last_completeness ?? null,
      revoked: {
        stockBalances: byEntity.get('stock_balances')?.revoked === true,
        items: byEntity.get('items')?.revoked === true,
        units: byEntity.get('units')?.revoked === true,
        itemCategories: byEntity.get('item_categories')?.revoked === true,
      },
    };
  }

  /**
   * Остатки 1С склада `warehouseRefKey` источника: SUM(КоличествоBalance) по позиции. Фильтр
   * удаления/пропажи — только на строках остатков; справочник позиций присоединяется LEFT JOIN
   * без фильтров пометки удаления (остаток на помеченной позиции реален). Отозванный справочник —
   * поля NULL, остаток остаётся. Нулевой/невалидный ключ позиции — строка отбрасывается.
   * Ключи копии (`source_key`, `…_Key`) хранятся в нижнем регистре — соединения по `source_key` без функций.
   */
  async stockBalances(
    sourceId: number,
    warehouseRefKey: string,
    revoked: OnecStockState['revoked'],
    client: DatabaseClient = this.db,
  ): Promise<OnecStockBalance[]> {
    await this.available(client);
    // Отозванные остатки до очистки ещё лежат в копии — не отдавать их никакому потребителю.
    if (revoked.stockBalances) return [];
    const { rows } = await client.query<{
      item_key: string; quantity: string; code: string | null; name: string | null;
      unit_name: string | null; category_key: string | null; category_name: string | null;
    }>(
      `WITH b AS (
         SELECT lower(data->>'Номенклатура_Key') AS item_key, sum((data->>'КоличествоBalance')::numeric) AS quantity
           FROM onec_etl_mirror_rows
          WHERE source_id = $1 AND entity_code = 'stock_balances' AND NOT deleted AND missing_in_source_at IS NULL
            AND lower(data->>'СтруктурнаяЕдиница_Key') = lower($2)
            AND data->>'Номенклатура_Key' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND lower(data->>'Номенклатура_Key') <> $3
            AND data->>'КоличествоBalance' ~ '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$'
          GROUP BY 1)
       SELECT b.item_key, b.quantity::text AS quantity,
              CASE WHEN $4 THEN NULL ELSE i.data->>'Code' END AS code,
              CASE WHEN $4 THEN NULL ELSE i.data->>'Description' END AS name,
              CASE WHEN $4 OR $5 THEN NULL ELSE COALESCE(u.data->>'Description', u.data->>'Представление') END AS unit_name,
              CASE WHEN $4 THEN NULL ELSE lower(i.data->>'КатегорияНоменклатуры_Key') END AS category_key,
              CASE WHEN $4 OR $6 THEN NULL ELSE COALESCE(c.data->>'Description', c.data->>'Представление') END AS category_name
         FROM b
         LEFT JOIN onec_etl_mirror_rows i ON i.source_id = $1 AND i.entity_code = 'items' AND i.source_key = b.item_key
         LEFT JOIN onec_etl_mirror_rows u ON u.source_id = $1 AND u.entity_code = 'units' AND u.source_key = lower(i.data->>'ЕдиницаИзмерения_Key')
         LEFT JOIN onec_etl_mirror_rows c ON c.source_id = $1 AND c.entity_code = 'item_categories' AND c.source_key = lower(i.data->>'КатегорияНоменклатуры_Key')
        ORDER BY b.item_key`,
      [sourceId, warehouseRefKey, ZERO_GUID, revoked.items, revoked.units, revoked.itemCategories],
    );
    return rows.map((row) => ({
      itemRefKey: row.item_key,
      code: row.code,
      name: row.name,
      unitName: row.unit_name,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      quantity: Number(row.quantity),
    }));
  }

  async listWarehouses(client: DatabaseClient = this.db, sourceIds?: readonly number[]): Promise<OnecWarehouse[]> {
    await this.available(client);
    const { rows } = await client.query<{ source_id: string; source_key: string; code: string | null; name: string }>(
      `SELECT source_id, source_key, data->>'Code' AS code, COALESCE(data->>'Description', source_key) AS name
         FROM onec_etl_mirror_rows
        WHERE entity_code = 'warehouses' AND NOT deleted AND missing_in_source_at IS NULL
          AND data->>'ТипСтруктурнойЕдиницы' = 'Склад'
          AND COALESCE((data->>'DeletionMark')::boolean, false) = false
          AND ($1::bigint[] IS NULL OR source_id = ANY($1::bigint[]))
        ORDER BY name, source_key`,
      [sourceIds ? [...sourceIds] : null],
    );
    return rows.map((row) => ({
      sourceId: Number(row.source_id),
      refKey: String(row.source_key).toLowerCase(),
      code: row.code,
      name: String(row.name),
    }));
  }
}
