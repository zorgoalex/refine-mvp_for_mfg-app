import { useState, useEffect } from 'react';
import { can } from '../utils/permissions';
import { featureFlags } from '../config/featureFlags';
import { cutApi } from '../api/cutApi';
import type { CutSheetTypeOption } from '../api/types/cutApi.types';

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
  /** Full raw option objects including materialTypeId, thicknessMm, widthMm, heightMm. */
  rawOptions: CutSheetTypeOption[];
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
  const [rawOptions, setRawOptions] = useState<CutSheetTypeOption[]>([]);

  useEffect(() => {
    if (!enabled) {
      setRawOptions([]);
      return;
    }
    let cancelled = false;
    cutApi
      .listSheetTypes()
      .then((types) => {
        if (!cancelled) {
          setRawOptions(types);
        }
      })
      .catch(() => {
        // Best-effort: if the endpoint is unavailable the filter shows no options
        // (the cut job can still be created without a sheet-type filter).
        if (!cancelled) setRawOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const options = rawOptions.map((t) => ({ value: t.sheetMaterialTypeId, label: t.name }));
  const byId = new Map(options.map((o) => [o.value, o]));

  return { enabled, options, byId, rawOptions };
}
