// SP3 Task 10 — single source of truth for the DISPLAYED material name.
//
// Prime invariant: legacy orders (sheet_material_type_id IS NULL) render exactly
// as before SP3. For sheet orders the name must be the server-resolved
// COALESCE(sheet_material_types.name, materials.material_name). Display surfaces
// MUST NOT fetch sheet_material_types directly (order viewers lack
// sheet_materials.view) and MUST NOT trust the bridge materials row (read-only
// SP2 names drift). The authoritative name is therefore the server COALESCE that
// reaches the FE via:
//   - order_details_view.material_name (Hasura display, keyed by detail_id),
//   - detail.material_name on an order_details_view row,
//   - detail.material_name_resolved (edit-workspace store, Task 8 hydration),
//   - detail.materialName (backend read DTO).
// The legacy materials map remains ONLY as a defensive fallback for legacy rows.

type NameLookup =
  | Map<number | string, string | null | undefined>
  | Record<number | string, string | null | undefined>
  | null
  | undefined;

function lookup(source: NameLookup, key: number | string | null | undefined): string | null | undefined {
  if (source == null || key == null) return undefined;
  if (source instanceof Map) return source.get(key);
  return (source as Record<number | string, string | null | undefined>)[key];
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return v as string;
  }
  return null;
}

/**
 * Resolve the display material name for a single order detail.
 *
 * @param detail              detail row (Hasura order_details(_view) row, store detail, or backend DTO).
 * @param resolvedByDetailId  optional map detail_id -> server-resolved name from a
 *                            parallel order_details_view fetch (display surfaces).
 * @param materialsFallback   legacy material_id -> material_name map (defensive only).
 */
export function resolveDetailMaterialName(
  detail: {
    detail_id?: number | null;
    material_id?: number | null;
    material_name?: string | null;
    material_name_resolved?: string | null;
    materialName?: string | null;
  } | null | undefined,
  resolvedByDetailId?: NameLookup,
  materialsFallback?: NameLookup,
): string | null {
  if (!detail) return null;
  return firstNonEmpty(
    lookup(resolvedByDetailId, detail.detail_id),
    detail.material_name_resolved,
    detail.material_name,
    detail.materialName,
    lookup(materialsFallback, detail.material_id),
  );
}

/**
 * Resolve the order HEADER display material name (server COALESCE), independent of
 * details — handles header-only sheet orders and orders.material_id NULL.
 *
 * @param header  header object (orders_view row, store header, or backend header DTO).
 */
export function resolveHeaderMaterialName(
  header: {
    material_name?: string | null;
    material_name_resolved?: string | null;
    headerMaterialName?: string | null;
  } | null | undefined,
): string | null {
  if (!header) return null;
  return firstNonEmpty(
    header.material_name_resolved,
    header.material_name,
    header.headerMaterialName,
  );
}
