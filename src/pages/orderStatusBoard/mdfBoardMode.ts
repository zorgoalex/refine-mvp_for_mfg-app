import type { MdfEngineModeDto } from '../../api/mdfCorrectionApi';

/** §5.6 requirement 1: which rendering the MDF board (`cnc_today`) uses.
 * - `legacy`: today's legacy CNC rendering, unchanged (engine legacy/shadow, or a backend that
 *   predates the engine-mode endpoint — mirrors `isMdfEngineModeEndpointMissing`).
 * - `published`: cards, columns, issues, counters come only from the coherent published snapshot
 *   (engine active/read_only, published reads enabled and reachable).
 * - `unavailable`: engine is active/read_only but published reads are off or the request failed, or
 *   the engine-mode request itself failed for a reason other than 404. NEVER falls back to legacy. */
export type MdfBoardMode = 'legacy' | 'published' | 'unavailable';

export type MdfEngineModeFetchResult =
  | { kind: 'ok'; engineMode: MdfEngineModeDto }
  /** GET /orders/status-board/mdf-engine answered 404: a backend without the endpoint. */
  | { kind: 'endpointMissing' }
  /** Any other failure (network, 5xx, session change, ...): the mode is unknown. */
  | { kind: 'error' };

export interface SelectMdfBoardModeInput {
  engineModeFetch: MdfEngineModeFetchResult;
  /** True when the published-session fetch itself failed (network, 503, session change, ...).
   * Only meaningful (and only fetched by the caller) when engineMode is active/read_only AND
   * engineMode.publishedReads is true. */
  publishedReadsFailed: boolean;
}

export function selectMdfBoardMode(input: SelectMdfBoardModeInput): MdfBoardMode {
  const { engineModeFetch } = input;
  if (engineModeFetch.kind === 'endpointMissing') return 'legacy';
  if (engineModeFetch.kind === 'error') return 'unavailable';
  const { mode, publishedReads } = engineModeFetch.engineMode;
  if (mode === 'legacy' || mode === 'shadow') return 'legacy';
  if (mode === 'active' || mode === 'read_only') {
    if (!publishedReads || input.publishedReadsFailed) return 'unavailable';
    return 'published';
  }
  // Defensive: an unrecognized mode string is never treated as legacy.
  return 'unavailable';
}

/** What the board (`cnc_today`) actually renders, given the resolved `mode` and whether a published
 * session is currently loaded. §5.6 finding 5: legacy rendering is reached ONLY when `mode` is the
 * explicit `'legacy'` result (engine legacy/shadow, or a backend predating the engine-mode endpoint
 * — see `selectMdfBoardMode`'s `endpointMissing`/`legacy` handling). `mode === null` (engine-mode
 * and/or published-session requests still in flight) always resolves to `'loading'`, never falls
 * through to legacy. A defensive `'published'` mode with no session yet (should not normally happen
 * since the hook sets both together) also resolves to `'loading'` rather than legacy. */
export type MdfBoardRenderMode = 'loading' | 'unavailable' | 'published' | 'legacy';

export function resolveMdfBoardRenderMode(input: { mode: MdfBoardMode | null; hasSession: boolean }): MdfBoardRenderMode {
  if (input.mode === null) return 'loading';
  if (input.mode === 'unavailable') return 'unavailable';
  if (input.mode === 'published') return input.hasSession ? 'published' : 'loading';
  return 'legacy';
}
