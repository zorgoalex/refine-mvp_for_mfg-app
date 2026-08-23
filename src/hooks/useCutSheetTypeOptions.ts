import { useState, useEffect, useLayoutEffect } from 'react';
import { can } from '../utils/permissions';
import { featureFlags } from '../config/featureFlags';
import { cutApi } from '../api/cutApi';
import type { CutSheetTypeOption } from '../api/types/cutApi.types';
import { useOrderAsyncReadGuard, useOrderLifecycleReadActive } from '../query/orderLifecycleQueries';

export interface SheetTypeOption {
  value: number;
  label: string;
}

export interface UseCutSheetTypeOptionsResult {
  /**
   * Drives the existing sheet FILTER visibility on /cut: true when cut.view is
   * held AND the sheetMaterialsReads schema-read flag is active. Independent of
   * orders-write flags or catalog perms (Critic R22 B3).
   */
  enabled: boolean;
  /** Filter Select options ({ value, label }) — paired with `enabled` visibility. */
  options: SheetTypeOption[];
  byId: Map<number, SheetTypeOption>;
  /**
   * Full raw option objects (materialTypeId, thicknessMm, widthMm, heightMm) that
   * back the per-job sheet SELECTOR. Loaded whenever cut.view is held — gated on
   * cut.view ONLY, independent of sheetMaterialsReads (the data comes from the
   * cut.view-gated backend endpoint, not the read-layer), so the selector works
   * under useBackendCut even when the sheet schema-read flag is off.
   */
  rawOptions: CutSheetTypeOption[];
}

/**
 * Sheet-type options for /cut, sourced from the CUT-gated backend endpoint
 * GET /api/v1/cut-jobs/sheet-types (Variant B Task 11). Requires only cut.view;
 * no catalog-level read and no sheet_materials.view (Critic R22 B3).
 *
 * Two consumers with different gates:
 * - `enabled`/`options` = the sheet FILTER (cut.view + sheetMaterialsReads).
 * - `rawOptions` = the per-job sheet SELECTOR source (cut.view only). The fetch
 *   is gated on cut.view alone so the selector loads independent of the
 *   sheetMaterialsReads schema-read flag (Codex regression fix: backend cut data
 *   must not be gated behind a read-layer schema flag).
 */
export function useCutSheetTypeOptions(): UseCutSheetTypeOptionsResult {
  const ordinaryReadActive = useOrderLifecycleReadActive();
  const sheetTypesReadGuard = useOrderAsyncReadGuard('cut-sheet-type-options');
  const sheetTypesScopeKey = `${sheetTypesReadGuard.authNamespace}|cut-sheet-type-options`;
  const canViewCut = can('cut.view');
  // FILTER gate: cut.view + the sheetMaterialsReads schema-read flag.
  const enabled = can('cut.view') && featureFlags.sheetMaterialsReads;
  const [rawOptionsState, setRawOptionsState] = useState<{
    scopeKey: string;
    value: CutSheetTypeOption[];
  } | null>(null);
  const rawOptions = rawOptionsState?.scopeKey === sheetTypesScopeKey
    ? rawOptionsState.value
    : [];

  useLayoutEffect(() => {
    setRawOptionsState({ scopeKey: sheetTypesScopeKey, value: [] });
  }, [sheetTypesScopeKey]);

  useEffect(() => {
    // Options come from the cut.view-gated backend endpoint (not the read-layer),
    // so they load whenever cut.view is held, independent of sheetMaterialsReads.
    // This lets the per-job sheet selector work under useBackendCut even when the
    // sheet schema-read flag is off (Codex regression fix).
    if (!canViewCut) {
      setRawOptionsState({ scopeKey: sheetTypesScopeKey, value: [] });
      return;
    }
    if (!ordinaryReadActive) return;
    const token = sheetTypesReadGuard.capture();
    if (!token) return;
    let cancelled = false;
    cutApi
      .listSheetTypes()
      .then((types) => {
        if (!cancelled && sheetTypesReadGuard.isCurrent(token)) {
          setRawOptionsState({ scopeKey: sheetTypesScopeKey, value: types });
        }
      })
      .catch(() => {
        // Best-effort: if the endpoint is unavailable the filter shows no options
        // (the cut job can still be created without a sheet-type filter).
        if (!cancelled && sheetTypesReadGuard.isCurrent(token)) {
          setRawOptionsState({ scopeKey: sheetTypesScopeKey, value: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    canViewCut,
    ordinaryReadActive,
    sheetTypesReadGuard.capture,
    sheetTypesReadGuard.isCurrent,
    sheetTypesScopeKey,
  ]);

  const options = rawOptions.map((t) => ({ value: t.sheetMaterialTypeId, label: t.name }));
  const byId = new Map(options.map((o) => [o.value, o]));

  return { enabled, options, byId, rawOptions };
}
