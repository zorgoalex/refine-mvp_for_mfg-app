import { useState, useEffect } from 'react';
import { can } from '../utils/permissions';
import { featureFlags } from '../config/featureFlags';

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
 * Sources from a CUT-gated backend endpoint (Task 11). Until that endpoint is
 * live the options list is empty; the gate logic is correct now so the filter
 * render and permission model are ready.
 */
export function useCutSheetTypeOptions(): UseCutSheetTypeOptionsResult {
  const enabled = can('cut.view') && featureFlags.sheetMaterialsReads;
  const [options, setOptions] = useState<SheetTypeOption[]>([]);

  useEffect(() => {
    if (!enabled) {
      setOptions([]);
      return;
    }
    // Task 11 will add GET /api/v1/cut-jobs/sheet-types and wire it here.
    // The hook is ready to receive options once the endpoint exists.
  }, [enabled]);

  const byId = new Map(options.map((o) => [o.value, o]));

  return { enabled, options, byId };
}
