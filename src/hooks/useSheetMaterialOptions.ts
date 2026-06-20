import { useMemo } from 'react';
import { useSelect } from '@refinedev/antd';
import { can } from '../utils/permissions';
import { featureFlags } from '../config/featureFlags';
import { useOrderFormData, type SheetMaterialTypeOption } from './useOrderFormData';

export interface UseSheetMaterialOptionsResult {
  // The "Листовой материал" picker should render at all. SP3 sheet write is
  // backend-only (the shadow resolution lives in the NestJS command), and the
  // picker reads the sheet reference which needs sheet_materials.view. So:
  // backend orders WRITE on AND the current user has sheet_materials.view.
  enabled: boolean;
  canViewSheetMaterials: boolean;
  options: SheetMaterialTypeOption[];
  byId: Map<number, SheetMaterialTypeOption>;
  isLoading: boolean;
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
  const canViewSheetMaterials = can('sheet_materials.view');
  // SP3: the picker also requires the migration 029 schema (sheetMaterialsReads)
  // so the selected sheet_material_type_id round-trips through order_details and
  // the resolved name view; never render it before the Hasura metadata is applied.
  const enabled =
    featureFlags.useBackendOrdersWrite && canViewSheetMaterials && featureFlags.sheetMaterialsReads;

  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  // Hasura path only fires when the picker is enabled AND we are not using the
  // backend form-data reference — so a user without sheet_materials.view never
  // issues a sheet reference read in either mode.
  const { queryResult } = useSelect({
    resource: 'sheet_material_types',
    optionLabel: 'name',
    optionValue: 'sheet_material_type_id',
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: enabled && !useBackendReferences },
  });

  const options = useMemo<SheetMaterialTypeOption[]>(() => {
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
    }));
  }, [
    enabled,
    useBackendReferences,
    orderFormData.references.sheetMaterialTypes,
    queryResult?.data,
  ]);

  const byId = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );

  const isLoading = useBackendReferences
    ? orderFormData.isLoading
    : Boolean(queryResult?.isLoading);

  return { enabled, canViewSheetMaterials, options, byId, isLoading };
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
