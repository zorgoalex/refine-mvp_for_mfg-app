import { useMemo } from 'react';
import { useSelect } from '@refinedev/antd';
import { can } from '../utils/permissions';
import { featureFlags } from '../config/featureFlags';
import { useOrderFormData, type SheetMaterialTypeOption } from './useOrderFormData';
import { sortOptionsByRecency, useRecentReferences } from './useRecentReferences';

export interface UseSheetMaterialOptionsResult {
  // The "Листовой материал" picker should render at all. SP3 sheet write is
  // backend-only (the shadow resolution lives in the NestJS command), and the
  // picker reads the sheet reference which needs sheet_materials.view. So:
  // backend orders WRITE on AND the current user has sheet_materials.view.
  enabled: boolean;
  canViewSheetMaterials: boolean;
  /** Catalog order without cross-order user recency; use for order-local ranking. */
  catalogOptions: SheetMaterialTypeOption[];
  options: SheetMaterialTypeOption[];
  byId: Map<number, SheetMaterialTypeOption>;
  isLoading: boolean;
  promoteUsage: (entityId: number) => void;
}

export function isSheetMaterialPickerEnabled(
  useBackendOrdersWrite: boolean,
  canViewSheetMaterials: boolean,
  useBackendReferences: boolean,
  sheetMaterialsReads: boolean,
): boolean {
  return useBackendOrdersWrite
    && canViewSheetMaterials
    && (useBackendReferences || sheetMaterialsReads);
}

/**
 * Sources sheet-material picker options for the order form, gated on backend
 * write + sheet_materials.view. Dual-sourced exactly like `materials`:
 * backend form-data when `useBackendReferences`, else a Hasura `useSelect`.
 * Inactive types are still fetched (is_active in [true,false]) so a
 * deactivated-but-currently-selected sheet can be displayed/edited; the picker
 * disables inactive non-current options at render time.
 */
export function useSheetMaterialOptions(): UseSheetMaterialOptionsResult {
  const recency = useRecentReferences('sheet_material_types');
  const canViewSheetMaterials = can('sheet_materials.view');
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;
  // The legacy Hasura path still needs the schema cutover flag. Backend form-data
  // already reads sheet_material_types directly, so gating that path on the old
  // Hasura flag would leave the material picker empty in backend-only runtime config.
  const enabled = isSheetMaterialPickerEnabled(
    featureFlags.useBackendOrdersWrite,
    canViewSheetMaterials,
    useBackendReferences,
    featureFlags.sheetMaterialsReads,
  );

  // Hasura path only fires when the picker is enabled AND we are not using the
  // backend form-data reference — so a user without sheet_materials.view never
  // issues a sheet reference read in either mode.
  // NOTE: is_cuttable must be added to the Hasura SELECT-permission allowlist at
  // cutover (Task 13). The field is requested here unconditionally so the code is
  // ready; Hasura returns it once the permission column is whitelisted.
  const { queryResult } = useSelect({
    resource: 'sheet_material_types',
    optionLabel: 'name',
    optionValue: 'sheet_material_type_id',
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [
      { field: 'sort_order', order: 'asc' },
      { field: 'name', order: 'asc' },
      { field: 'sheet_material_type_id', order: 'asc' },
    ],
    meta: { fields: ['sheet_material_type_id', 'name', 'width_mm', 'height_mm', 'is_active', 'is_cuttable', 'sort_order'] },
    pagination: { mode: 'off' },
    queryOptions: { enabled: enabled && !useBackendReferences },
  });

  const catalogOptions = useMemo<SheetMaterialTypeOption[]>(() => {
    if (!enabled) return [];
    if (useBackendReferences) {
      return orderFormData.references.sheetMaterialTypes;
    }
    const rows = (queryResult?.data?.data ?? []) as any[];
    return rows.map((row) => ({
      label: row.name,
      value: row.sheet_material_type_id,
      widthMm: row.width_mm != null ? Number(row.width_mm) : null,
      heightMm: row.height_mm != null ? Number(row.height_mm) : null,
      isActive: row.is_active,
      // Hasura column available after Task 13 allowlist cutover; default true
      // so that all types remain selectable until the column is whitelisted.
      isCuttable: row.is_cuttable != null ? Boolean(row.is_cuttable) : true,
      sortOrder: row.sort_order != null ? Number(row.sort_order) : 100,
    }));
  }, [
    enabled,
    useBackendReferences,
    orderFormData.references.sheetMaterialTypes,
    queryResult?.data,
  ]);

  const options = useMemo(
    () => sortOptionsByRecency(catalogOptions, recency.recentIds),
    [catalogOptions, recency.recentIds],
  );

  const byId = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );

  const isLoading = useBackendReferences
    ? orderFormData.isLoading
    : Boolean(queryResult?.isLoading);

  return {
    enabled,
    canViewSheetMaterials,
    catalogOptions,
    options,
    byId,
    isLoading,
    promoteUsage: recency.promote,
  };
}

/**
 * Filters a sheet-material option list to cuttable types only.
 * Use for DETAIL pickers (panels/cuts). The HEADER picker keeps the full list
 * so a header may legitimately carry a non-cuttable material (e.g. «краска»).
 */
export function filterCuttableOptions(options: SheetMaterialTypeOption[]): SheetMaterialTypeOption[] {
  return options.filter((o) => o.isCuttable === true);
}

/**
 * antd Select options for a sheet picker: disables inactive types EXCEPT the one
 * currently selected on this row/header (so a deactivated selected sheet stays
 * editable but cannot be newly chosen).
 */
export function toSheetSelectOptions(
  options: SheetMaterialTypeOption[],
  currentValue: number | null | undefined,
) {
  return options.map((option) => ({
    label: option.isActive ? option.label : `${option.label} (неактивный)`,
    value: option.value,
    disabled: !option.isActive && option.value !== currentValue,
  }));
}
