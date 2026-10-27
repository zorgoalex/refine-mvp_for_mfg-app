import type { DatabaseClient } from '../../../database/database.types';
import { invalid, type MaterialKind, type MaterialSupplierRef } from '../application/material-suppliers';

/** Колонка владельца строки `material_suppliers` (фиксированный список — в SQL подставляется только он). */
const OWNER_COLUMN: Record<MaterialKind, string> = {
  film: 'film_id',
  sheet_material: 'sheet_material_type_id',
  extra_resource: 'extra_resource_id',
};

interface SupplierRow {
  owner_id: string | number;
  supplier_id: string | number;
  supplier_name: string | null;
  is_active: boolean;
}

/** Ручные списки поставщиков позиций (по порядку); у позиции без списка — пустой массив. */
export async function loadMaterialSuppliers(
  client: DatabaseClient,
  kind: MaterialKind,
  ownerIds: readonly number[],
): Promise<Map<number, MaterialSupplierRef[]>> {
  const result = new Map<number, MaterialSupplierRef[]>(ownerIds.map((id) => [id, []]));
  if (ownerIds.length === 0) return result;
  const column = OWNER_COLUMN[kind];
  const rows = (await client.query<SupplierRow>(
    `SELECT ms.${column} AS owner_id, ms.supplier_id, s.supplier_name, s.is_active
       FROM material_suppliers ms
       JOIN suppliers s ON s.supplier_id = ms.supplier_id
      WHERE ms.resource_kind = $1 AND ms.${column} = ANY($2::bigint[])
      ORDER BY ms.${column}, ms.position`,
    [kind, ownerIds],
  )).rows;
  for (const row of rows) result.get(Number(row.owner_id))?.push(toRef(row));
  return result;
}

/** Поставщики по id (для основного поставщика листового). */
export async function loadSuppliersById(client: DatabaseClient, ids: readonly number[]): Promise<Map<number, MaterialSupplierRef>> {
  if (ids.length === 0) return new Map();
  const rows = (await client.query<Omit<SupplierRow, 'owner_id'>>(
    `SELECT supplier_id, supplier_name, is_active FROM suppliers WHERE supplier_id = ANY($1::int[])`,
    [[...new Set(ids)]],
  )).rows;
  return new Map(rows.map((row) => [Number(row.supplier_id), toRef(row)]));
}

/**
 * Проверка новых поставщиков списка: существуют, а добавляемые (их не было в списке) — активны. Оставшегося в списке
 * отключённого поставщика не выкидываем: иначе правка другого поля позиции стала бы невозможной.
 */
export async function assertSuppliersSelectable(
  client: DatabaseClient,
  ids: readonly number[],
  previousIds: readonly number[],
): Promise<void> {
  if (ids.length === 0) return;
  const found = await loadSuppliersById(client, ids);
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw invalid(`Поставщик не найден: ${missing.join(', ')}`);
  const inactive = ids.filter((id) => !previousIds.includes(id) && found.get(id)?.isActive === false);
  if (inactive.length > 0) throw invalid(`Поставщик отключён: ${inactive.map((id) => found.get(id)?.name ?? id).join(', ')}`);
}

/**
 * Заменить список позиции: удалить и вставить по порядку (position 1..n). Вызывается в транзакции команды-владельца
 * после блокировки строки позиции (`FOR UPDATE`) — гонок между двумя заменами одного списка нет.
 */
export async function replaceMaterialSuppliers(
  client: DatabaseClient,
  kind: MaterialKind,
  ownerId: number,
  supplierIds: readonly number[],
  actorUserId: number | null,
): Promise<void> {
  const column = OWNER_COLUMN[kind];
  await client.query(`DELETE FROM material_suppliers WHERE resource_kind = $1 AND ${column} = $2`, [kind, ownerId]);
  if (supplierIds.length === 0) return;
  await client.query(
    `INSERT INTO material_suppliers (resource_kind, ${column}, supplier_id, position, created_by)
     SELECT $1, $2, supplier_id, position::smallint, $4
       FROM unnest($3::int[]) WITH ORDINALITY AS list(supplier_id, position)`,
    [kind, ownerId, supplierIds, actorUserId],
  );
}

/** Поставщики позиции по приходам 1С (журнал `resource_suppliers`, только чтение). */
export async function loadOnecSuppliers(
  client: DatabaseClient,
  kind: 'film' | 'sheet_material',
  ownerIds: readonly number[],
): Promise<Map<number, Array<{ key: string; name: string }>>> {
  const result = new Map<number, Array<{ key: string; name: string }>>(ownerIds.map((id) => [id, []]));
  if (ownerIds.length === 0) return result;
  const column = kind === 'film' ? 'film_id' : 'sheet_material_type_id';
  const rows = (await client.query<{ owner_id: string | number; supplier_key: string; name: string | null }>(
    `SELECT rs.${column} AS owner_id, rs.supplier_key,
            COALESCE(NULLIF(btrim(s.supplier_name), ''), rs.counterparty_name) AS name
       FROM resource_suppliers rs
       LEFT JOIN suppliers s ON s.supplier_id = rs.supplier_id
      WHERE rs.resource_kind = $1 AND rs.${column} = ANY($2::bigint[])
      ORDER BY rs.${column}, rs.first_seen_at, rs.resource_supplier_id`,
    [kind, ownerIds],
  )).rows;
  for (const row of rows) {
    result.get(Number(row.owner_id))?.push({ key: row.supplier_key, name: row.name?.trim() || row.supplier_key.slice(2) });
  }
  return result;
}

function toRef(row: { supplier_id: string | number; supplier_name: string | null; is_active: boolean }): MaterialSupplierRef {
  const id = Number(row.supplier_id);
  return { id, name: row.supplier_name?.trim() || `Поставщик #${id}`, isActive: Boolean(row.is_active) };
}

/**
 * Основной поставщик позиции для потребностей и снабжения (одно правило, migr 280): листовой — его основной
 * (`sheet_material_types.supplier_id`), иначе первый из дополнительных; плёнка — первый из выбранных; иначе — самый
 * ранний по приходам 1С. Производитель (`vendors`) сюда не входит. Ключ — `sheet_material:<id>` / `film:<id>`.
 */
export async function loadMainSupplierNames(
  client: DatabaseClient,
  sheetIds: readonly number[],
  filmIds: readonly number[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (sheetIds.length > 0) {
    const mains = (await client.query<{ id: string | number; supplier_name: string | null; supplier_id: string | number }>(
      `SELECT smt.sheet_material_type_id AS id, s.supplier_id, s.supplier_name
         FROM sheet_material_types smt JOIN suppliers s ON s.supplier_id = smt.supplier_id
        WHERE smt.sheet_material_type_id = ANY($1::bigint[])`,
      [sheetIds],
    )).rows;
    for (const row of mains) {
      result.set(`sheet_material:${Number(row.id)}`, row.supplier_name?.trim() || `Поставщик #${Number(row.supplier_id)}`);
    }
  }
  for (const [kind, ids] of [['sheet_material', sheetIds], ['film', filmIds]] as const) {
    if (ids.length === 0) continue;
    const chosen = await loadMaterialSuppliers(client, kind, ids);
    const onec = await loadOnecSuppliers(client, kind, ids);
    for (const id of ids) {
      const key = `${kind}:${id}`;
      if (result.has(key)) continue;
      const name = chosen.get(id)?.[0]?.name ?? onec.get(id)?.[0]?.name;
      if (name) result.set(key, name);
    }
  }
  return result;
}
