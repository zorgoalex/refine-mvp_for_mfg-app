// «Параметры деталей по умолчанию» of the order form: values put into every new detail row (quick add, «вставить
// строку», «Добавить деталь»); each row can still be changed. Untouched, they are the long-standing defaults —
// «Модерн», «р-1», the material of the preceding new row or the catalog default — so nothing changes until set.
import type { OrderDetail } from '../../types/orders';

export const BASE_MILLING_TYPE_ID = 1; // Модерн
export const BASE_EDGE_TYPE_ID = 1; // р-1

export interface DetailDefaults {
  /** null — the material rule of new rows (the preceding new row, else the catalog default) */
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  millingTypeId: number;
  edgeTypeId: number;
  /** «Цена за м²»; null — empty, as before */
  pricePerSqm: number | null;
}

export const INITIAL_DETAIL_DEFAULTS: DetailDefaults = {
  sheetMaterialTypeId: null,
  filmId: null,
  millingTypeId: BASE_MILLING_TYPE_ID,
  edgeTypeId: BASE_EDGE_TYPE_ID,
  pricePerSqm: null,
};

const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Fields of a new detail row. `ruleMaterialId` — what the material rule gives for this row. */
export function newDetailDefaults(
  defaults: DetailDefaults,
  ruleMaterialId: number | undefined,
): Partial<Omit<OrderDetail, 'temp_id'>> {
  const material = positiveId(defaults.sheetMaterialTypeId) ? defaults.sheetMaterialTypeId : ruleMaterialId;
  const price = validPrice(defaults.pricePerSqm);
  return {
    milling_type_id: positiveId(defaults.millingTypeId) ? defaults.millingTypeId : BASE_MILLING_TYPE_ID,
    edge_type_id: positiveId(defaults.edgeTypeId) ? defaults.edgeTypeId : BASE_EDGE_TYPE_ID,
    ...(material != null ? { sheet_material_type_id: material } : {}),
    ...(positiveId(defaults.filmId) ? { film_id: defaults.filmId } : {}),
    // the marker keeps an unfilled row with a default price an empty row (see orderDetailRows)
    ...(price != null ? { milling_cost_per_sqm: price, prefilled_milling_cost_per_sqm: price } : {}),
  };
}

const validPrice = (value: number | null): number | null =>
  value != null && Number.isFinite(value) && value > 0 ? value : null;

/**
 * The values the defaults give an untouched grid row opened in the inline editor — every field explicitly
 * (null where the default is empty), so a later change of the defaults can tell which fields are still theirs.
 */
export function rowDefaultFormValues(defaults: DetailDefaults, ruleMaterialId: number | undefined): Record<string, unknown> {
  const values = newDetailDefaults(defaults, ruleMaterialId);
  return {
    milling_type_id: values.milling_type_id,
    edge_type_id: values.edge_type_id,
    sheet_material_type_id: values.sheet_material_type_id ?? null,
    film_id: values.film_id ?? null,
    milling_cost_per_sqm: values.milling_cost_per_sqm ?? null,
    prefilled_milling_cost_per_sqm: values.prefilled_milling_cost_per_sqm ?? null,
  };
}

/** Defaults kept in the tab checkpoint (a restored tab keeps them); anything malformed — null. */
export function readDetailDefaults(raw: unknown): DetailDefaults | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const idOrNull = (item: unknown) => (item === null ? null : positiveId(item) ? item : undefined);
  const material = idOrNull(value.sheetMaterialTypeId);
  const film = idOrNull(value.filmId);
  const price = value.pricePerSqm === null ? null : typeof value.pricePerSqm === 'number' ? validPrice(value.pricePerSqm) : undefined;
  if (material === undefined || film === undefined || price === undefined) return null;
  if (!positiveId(value.millingTypeId) || !positiveId(value.edgeTypeId)) return null;
  return { sheetMaterialTypeId: material, filmId: film, millingTypeId: value.millingTypeId, edgeTypeId: value.edgeTypeId, pricePerSqm: price };
}

/** How many defaults differ from the untouched ones (the «изменено» mark). */
export function changedDetailDefaults(defaults: DetailDefaults): number {
  return (Object.keys(INITIAL_DETAIL_DEFAULTS) as Array<keyof DetailDefaults>)
    .filter((key) => defaults[key] !== INITIAL_DETAIL_DEFAULTS[key]).length;
}
