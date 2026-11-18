// Запись сопоставлений материалов Базиса (bazis_material_mappings) внутри транзакции команды
// PUT /bazis/material-mappings. Вынесено отдельно, чтобы порядок блокировок фрезеровок
// проверялся PG-тестом на настоящей базе (bazis-material-mapping-writes.integration.test.ts).

import type { DatabaseClient } from '../../../database/database.types';
import type { UpsertMaterialMappingDto } from '../dto/bazis.dto';
import { normalizeBazisReferenceName } from '../application/bazis-panel-film';

type Queryable = Pick<DatabaseClient, 'query'>;

// SQL-зеркало normalizeBazisReferenceName: lower + trim + ё→е + схлопывание пробелов.
export const BAZIS_NAME_NORMALIZED_SQL = (column: string): string =>
  `regexp_replace(replace(lower(btrim(${column})), 'ё', 'е'), '[[:space:]]+', ' ', 'g')`;

export interface BazisMaterialMappingWriteRow extends Record<string, unknown> {
  bazis_material_mapping_id: number | string;
  source_kind: string;
  bazis_name: string;
  target_kind: string;
  sheet_material_type_id: number | string | null;
  film_id: number | string | null;
  edge_type_id: number | string | null;
  milling_type_id: number | string | null;
}

/**
 * Разные написания одной фрезеровки — разные строки (уникальность по lower(bazis_name)), но
 * один выбор (syncMillingMappingSpellings). Запись сериализуется по нормализованному имени ДО
 * UPSERT, ключи — в стабильном порядке: иначе два параллельных сохранения разных написаний
 * блокируют каждое свою строку и затем ждут чужую (deadlock).
 */
export async function lockMillingMappingNames(
  tx: Queryable,
  items: ReadonlyArray<Pick<UpsertMaterialMappingDto, 'sourceKind' | 'bazisName'>>,
): Promise<string[]> {
  const keys = [
    ...new Set(
      items
        .filter((item) => item.sourceKind === 'milling')
        .map((item) => normalizeBazisReferenceName(item.bazisName)),
    ),
  ].sort();
  for (const key of keys) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
      `bazis-milling-mapping:${key}`,
    ]);
  }
  return keys;
}

export async function upsertMaterialMappingRow(
  tx: Queryable,
  item: UpsertMaterialMappingDto,
  actorUserId: number | null,
): Promise<BazisMaterialMappingWriteRow> {
  const result = await tx.query<BazisMaterialMappingWriteRow>(
    `
    INSERT INTO bazis_material_mappings
      (source_kind, bazis_name, target_kind, sheet_material_type_id, film_id, edge_type_id,
       milling_type_id, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$8,$7,$7)
    ON CONFLICT (source_kind, lower(bazis_name)) DO UPDATE SET
      target_kind = EXCLUDED.target_kind,
      sheet_material_type_id = EXCLUDED.sheet_material_type_id,
      film_id = EXCLUDED.film_id,
      edge_type_id = EXCLUDED.edge_type_id,
      milling_type_id = EXCLUDED.milling_type_id,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING *
    `,
    [
      item.sourceKind,
      item.bazisName,
      item.targetKind,
      item.sheetMaterialTypeId ?? null,
      item.filmId ?? null,
      item.edgeTypeId ?? null,
      actorUserId,
      item.millingTypeId ?? null,
    ],
  );
  return result.rows[0] as BazisMaterialMappingWriteRow;
}

/** Другие написания той же фрезеровки (регистр/пробелы/ё) получают тот же выбор. */
export async function syncMillingMappingSpellings(
  tx: Queryable,
  item: UpsertMaterialMappingDto,
  actorUserId: number | null,
): Promise<void> {
  if (item.sourceKind !== 'milling') {
    return;
  }
  await tx.query(
    `
    UPDATE bazis_material_mappings
    SET target_kind = $2, milling_type_id = $3, updated_by = $4, updated_at = now()
    WHERE source_kind = 'milling'
      AND ${BAZIS_NAME_NORMALIZED_SQL('bazis_name')} = ${BAZIS_NAME_NORMALIZED_SQL('$1::text')}
      AND lower(bazis_name) <> lower($1::text)
    `,
    [item.bazisName, item.targetKind, item.millingTypeId ?? null, actorUserId],
  );
}
