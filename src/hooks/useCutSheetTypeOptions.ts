import { useState, useEffect } from 'react';
import { can } from '../utils/permissions';
import { featureFlags } from '../config/featureFlags';
import { cutApi } from '../api/cutApi';

export interface SheetTypeOption {
  value: number;
  label: string;
}

export interface UseCutSheetTypeOptionsResult {
  /**
   * True when the cut.view permission is held AND sheetMaterialsReads is active.
   * Gated on cut.view ONLY — independent of orders-write flags or catalog perms (Critic R22 B3).
   */
  enabled: boolean;
  options: SheetTypeOption[];
  byId: Map<number, SheetTypeOption>;
}

/**
 * Sheet-type options for the /cut filter, gated exclusively on cut.view +
 * sheetMaterialsReads. Requires only cut.view — independent of orders-write
 * flags or catalog-level sheet perms (Critic R22 B3). The cut module is self-contained.
 *
 * Sources from the CUT-gated backend endpoint GET /api/v1/cut-jobs/sheet-types
 * (Variant B Task 11). No catalog-level read. No sheet_materials.view required —
 * worker (cut.view only) gets cut filter options via this endpoint.
 */
export function useCutSheetTypeOptions(): UseCutSheetTypeOptionsResult {
  const enabled = can('cut.view') && featureFlags.sheetMaterialsReads;
  const [options, setOptions] = useState<SheetTypeOption[]>([]);

  useEffect(() => {
    if (!enabled) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    cutApi
      .listSheetTypes()
      .then((types) => {
        if (!cancelled) {
          setOptions(types.map((t) => ({ value: t.sheetMaterialTypeId, label: t.name })));
        }
      })
      .catch(() => {
        // Best-effort: if the endpoint is unavailable the filter shows no options
        // (the cut job can still be created without a sheet-type filter).
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const byId = new Map(options.map((o) => [o.value, o]));

  return { enabled, options, byId };
}
