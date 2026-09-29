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

  /** Все источники, по которым выгружались склады (часовой проход автосинхронизации). */
  async warehouseSourceIds(client: DatabaseClient = this.db): Promise<number[]> {
    await this.available(client);
    const { rows } = await client.query<{ source_id: string }>(
      `SELECT source_id FROM onec_etl_entity_state WHERE entity_code = 'warehouses' ORDER BY source_id`,
    );
    return rows.map((row) => Number(row.source_id));
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
