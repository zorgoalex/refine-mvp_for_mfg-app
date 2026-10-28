import { useCallback, useEffect, useRef, useState } from 'react';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { mdfCorrectionApi } from '../../api/mdfCorrectionApi';
import { authSession } from '../../api/authSession';
import { mdfPublishedApi } from '../../api/mdfPublishedApi';
import type { MdfSessionSnapshot, MdfSourceKind } from '../../api/types/mdfPublishedApi.types';
import {
  bumpMdfBoardGeneration,
  createMdfBoardGenerationState,
  isMdfBoardGenerationCurrent,
  type MdfBoardGenerationState,
} from './mdfBoardGeneration';
import {
  mdfBoardOpenPrefetchFresh,
  takePrefetchedMdfEngineMode,
  takePrefetchedMdfSnapshot,
} from '../../api/mdfBoardOpenPrefetch';
import { selectMdfBoardMode, type MdfBoardMode, type MdfEngineModeFetchResult } from './mdfBoardMode';
import { isMdfEngineModeEndpointMissing } from './mdfReturnSelection';
import { planMdfPublishedSearchOrderIds } from './mdfPublishedBoard';
import { buildCncOrderSearchDateRange, type CncOrderSearchPeriod } from './model';

const POLL_INTERVAL_MS = 15000;

export interface UseMdfPublishedBoardParams {
  /** `active && isCncToday`. When false the hook does no IO and keeps what it shows (see the query effect). */
  enabled: boolean;
  workday: string;
  /** The board's period selector (defaults to `1w` inside `buildCncOrderSearchDateRange` when
   * undefined) — drives `displayFrom`, the legacy-parity display cut sent to the backend. Changing
   * it must refetch (see the query-change effect below). */
  period: CncOrderSearchPeriod | undefined;
  focusKind: MdfSourceKind | null;
  focusId: string | null;
  /** Hybrid board: orders with MDF demand whose positions the snapshot would not otherwise carry (no engine card
   * of theirs in the window). At most 100 — the endpoint's bound. */
  orderIds?: readonly number[];
  /** A hidden board mounted on a warmed-up first view (sign-in / menu warm-up): it applies the warmed engine mode and
   * snapshot once, without any network read or polling, so it is fully rendered before it is shown. */
  warmHidden?: boolean;
}

export interface UseMdfPublishedBoardResult {
  /** null while the engine mode has not been resolved yet (first load). */
  mode: MdfBoardMode | null;
  session: MdfSessionSnapshot | null;
  loading: boolean;
  /** `mdfPublishedQueryKey` of the query the shown mode/session were resolved for; null before the first. A page
   * looking for a card in what is shown waits until this matches its current query. */
  settledQueryKey: string | null;
  searchOrderIds: number[];
  searchResolving: boolean;
  refresh: () => void;
  /** §5.6d: order names the user selected/typed that may be outside the loaded window. Resolves
   * unknown names to order ids (via the existing order-search endpoint) and, once resolved,
   * requests them again as `searchOrderIds` so their old/completed cards appear. */
  requestSearchOrderNames: (names: readonly string[]) => void;
}

/** The early snapshot is used only if the auth session it was read under is still current when the mode settles;
 * otherwise (re-login, permission refresh) it is dropped and read again under the current session. */
export async function currentSessionSnapshot(early: Promise<MdfSessionSnapshot> | null,
  read: () => Promise<MdfSessionSnapshot>, currentGeneration: () => number): Promise<MdfSessionSnapshot> {
  const snapshot = early ? await early : await read();
  return snapshot.sessionGeneration === currentGeneration() ? snapshot : read();
}

export function mdfPublishedQueryKey(workday: string, period: CncOrderSearchPeriod | undefined,
  focusKind: MdfSourceKind | null, focusId: string | null): string {
  return [workday, period ?? '', focusKind && focusId ? `${focusKind}:${focusId}` : ''].join('|');
}

export function useMdfPublishedBoard(params: UseMdfPublishedBoardParams): UseMdfPublishedBoardResult {
  const { enabled, workday, period, focusKind, focusId } = params;
  const orderIdsKey = (params.orderIds ?? []).slice(0, 100).join(',');
  const [mode, setMode] = useState<MdfBoardMode | null>(null);
  const modeRef = useRef<MdfBoardMode | null>(null);
  modeRef.current = mode;
  const [session, setSession] = useState<MdfSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [settledQueryKey, setSettledQueryKey] = useState<string | null>(null);
  const [searchOrderIds, setSearchOrderIds] = useState<number[]>([]);
  const [searchResolving, setSearchResolving] = useState(false);

  const generationRef = useRef<MdfBoardGenerationState>(createMdfBoardGenerationState());
  // the workday the shown snapshot was read for
  const shownWorkdayRef = useRef<string | null>(null);
  const refreshAfterStalePrefetchRef = useRef<() => void>(() => undefined);
  const sessionRef = useRef<MdfSessionSnapshot | null>(null);
  const searchOrderIdsRef = useRef<number[]>([]);
  const orderIdsRef = useRef<number[]>([]);
  orderIdsRef.current = orderIdsKey ? orderIdsKey.split(',').map(Number) : [];
  const resolvedNamesRef = useRef(new Map<string, number | null>());
  const enabledRef = useRef(enabled);
  // §5.6 R2#3: bumped on every `requestSearchOrderNames` call; an in-flight async name→id
  // resolution only applies its result (setSearchOrderIds) if this is still the latest call —
  // otherwise a newer selection (already applied synchronously by its own call) would be clobbered
  // by a stale, superseded resolution finishing out of order.
  const searchRequestSeqRef = useRef(0);
  // Count of resolutions currently in flight — independent of `searchRequestSeqRef` supersession,
  // so `searchResolving` reflects "something is resolving" and never gets stuck true (a superseded
  // call's `finally` still needs to release its own count) nor gets released early by a superseded
  // call's `finally` while a newer one is still running.
  const pendingResolutionCountRef = useRef(0);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { searchOrderIdsRef.current = searchOrderIds; }, [searchOrderIds]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const bump = useCallback((): number => {
    const { state, requestGeneration } = bumpMdfBoardGeneration(generationRef.current);
    generationRef.current = state;
    return requestGeneration;
  }, []);

  const runCycle = useCallback(async (requestGeneration: number, warmOnly = false) => {
    if (!warmOnly) setLoading(true);
    const startSessionGeneration = authSession.getSessionGeneration();
    // Legacy-parity display cut: the same `dateFrom` the legacy board computes for this
    // workday+period via `buildCncOrderSearchDateRange` (default period `1w` → workday − 6 days).
    // Search/focus reach older cards regardless — this only trims the default payload.
    const displayFrom = buildCncOrderSearchDateRange(workday, period).dateFrom;
    const readPublished = () => mdfPublishedApi.get({
      dateTo: workday,
      displayFrom,
      ...(focusKind && focusId ? { focus: { kind: focusKind, id: focusId } } : {}),
      ...(searchOrderIdsRef.current.length ? { searchOrderIds: searchOrderIdsRef.current } : {}),
      ...(orderIdsRef.current.length ? { orderIds: orderIdsRef.current } : {}),
    });
    // Unless the board is known to be legacy, the snapshot is requested beside the mode instead of after it;
    // the mode still decides whether that result is used at all.
    // A direct open may have started both reads already (mdfBoardOpenPrefetch); its default query only.
    const plainQuery = !(focusKind && focusId) && !searchOrderIdsRef.current.length && !orderIdsRef.current.length;
    // a prefetch older than its fresh window is shown at once and read again right after
    const prefetchStale = !mdfBoardOpenPrefetchFresh();
    const prefetchedSnapshot = modeRef.current === 'legacy' || !plainQuery ? null
      : takePrefetchedMdfSnapshot({ dateTo: workday, displayFrom }, { networkFallback: !warmOnly });
    // warm-only (hidden board): only the warmed reads of exactly this query, never the network — a failed one, or one
    // of another auth session, ends the warm render (the board reads when it is shown)
    if (warmOnly && !prefetchedSnapshot) return;
    const prefetchedMode = takePrefetchedMdfEngineMode({ networkFallback: !warmOnly });
    if (warmOnly && !prefetchedMode) return;
    const usedStalePrefetch = prefetchStale && Boolean(prefetchedSnapshot || prefetchedMode);
    const earlyRead = modeRef.current === 'legacy' ? null : prefetchedSnapshot ?? readPublished();
    earlyRead?.catch(() => undefined);
    let engineModeFetch: MdfEngineModeFetchResult;
    try {
      const engineMode = await (prefetchedMode ?? mdfCorrectionApi.getEngineMode());
      engineModeFetch = { kind: 'ok', engineMode };
    } catch (error) {
      if (warmOnly) return;
      engineModeFetch = isMdfEngineModeEndpointMissing(error) ? { kind: 'endpointMissing' } : { kind: 'error' };
    }
    if (!isMdfBoardGenerationCurrent(generationRef.current, requestGeneration) || (!warmOnly && !enabledRef.current)) return;
    if (warmOnly && authSession.getSessionGeneration() !== startSessionGeneration) return;

    const needsPublishedFetch = engineModeFetch.kind === 'ok'
      && (engineModeFetch.engineMode.mode === 'active' || engineModeFetch.engineMode.mode === 'read_only')
      && engineModeFetch.engineMode.publishedReads;
    if (!needsPublishedFetch) {
      const resolvedMode = selectMdfBoardMode({ engineModeFetch, publishedReadsFailed: false });
      shownWorkdayRef.current = workday;
      setMode(resolvedMode);
      setSession(null);
      setSettledQueryKey(mdfPublishedQueryKey(workday, period, focusKind, focusId));
      setLoading(false);
      if (usedStalePrefetch && !warmOnly) refreshAfterStalePrefetchRef.current();
      return;
    }
    let publishedReadsFailed = false;
    let nextSession: MdfSessionSnapshot | null = null;
    try {
      if (warmOnly) {
        nextSession = await earlyRead;
        if (nextSession?.sessionGeneration !== authSession.getSessionGeneration()) return;
      } else {
        nextSession = await currentSessionSnapshot(earlyRead, readPublished, () => authSession.getSessionGeneration());
      }
    } catch {
      if (warmOnly) return;
      publishedReadsFailed = true;
    }
    if (!isMdfBoardGenerationCurrent(generationRef.current, requestGeneration) || (!warmOnly && !enabledRef.current)) return;
    const resolvedMode = selectMdfBoardMode({ engineModeFetch, publishedReadsFailed });
    shownWorkdayRef.current = workday;
    setMode(resolvedMode);
    setSession(resolvedMode === 'published' ? nextSession : null);
    setSettledQueryKey(mdfPublishedQueryKey(workday, period, focusKind, focusId));
    setLoading(false);
    if (usedStalePrefetch && !warmOnly) refreshAfterStalePrefetchRef.current();
  }, [workday, period, focusKind, focusId]);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return;
    const requestGeneration = bump();
    void runCycle(requestGeneration);
  }, [bump, runCycle]);
  refreshAfterStalePrefetchRef.current = refresh;

  // Query change (workday, period — which drives `displayFrom` — focus, mode-affecting session
  // state, searchOrderIds) or enable/disable: one board-wide generation bump per change, superseded
  // responses dropped (§5.6 req 7 / R2#2).
  // Hidden board (another screen is open): reads stop, but what it shows stays — coming back shows it at once and
  // refreshes in the background. A snapshot of another workday is never shown (whenever the day differs, also after
  // the page restores the URL); one of another auth session is never returned (see `shownSession` below).
  useEffect(() => {
    const requestGeneration = bump();
    if (!enabled) {
      setLoading(false);
      if (params.warmHidden && modeRef.current === null) void runCycle(requestGeneration, true);
      return;
    }
    if (shownWorkdayRef.current !== null && shownWorkdayRef.current !== workday) {
      setMode(null);
      setSession(null);
      setSettledQueryKey(null);
      shownWorkdayRef.current = null;
    }
    void runCycle(requestGeneration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, params.warmHidden, workday, period, focusKind, focusId, searchOrderIds.join(','), orderIdsKey]);

  // Refresh every 15s and on tab visibility, like the legacy board.
  useEffect(() => {
    if (!enabled) return undefined;
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, refresh]);

  const requestSearchOrderNames = useCallback((names: readonly string[]) => {
    // §5.6 R2#3: this call's sequence number — a strictly increasing counter, not the board-wide
    // generation (which also changes on refresh/workday/focus and would falsely mark this call
    // superseded). Only a later `requestSearchOrderNames` call may invalidate an earlier one.
    const seq = ++searchRequestSeqRef.current;
    const knownOrders = sessionRef.current?.snapshot.orders ?? [];
    const plan = planMdfPublishedSearchOrderIds({
      requestedOrderNames: names,
      knownOrders,
      resolvedOrderIds: resolvedNamesRef.current,
      currentSearchOrderIds: searchOrderIdsRef.current,
    });
    // §5.6 R2#2: apply the CURRENT selection's known/already-resolved ids immediately — this is
    // what clears/shrinks searchOrderIds when a tag is removed or the selection is cleared
    // (`nextSearchOrderIds` can legitimately be `[]`, so check for `null`, not truthiness).
    if (plan.nextSearchOrderIds !== null) {
      setSearchOrderIds(plan.nextSearchOrderIds);
    }
    // §5.6 R2#3: still resolve any unknown names, even when known ids ALSO changed above — a
    // combined known+unknown selection must not drop the unknown name's resolution.
    if (plan.namesNeedingResolution.length === 0) return;
    pendingResolutionCountRef.current += 1;
    setSearchResolving(true);
    void (async () => {
      try {
        for (const name of plan.namesNeedingResolution) {
          const key = name.trim().toLocaleLowerCase('ru-RU');
          if (!resolvedNamesRef.current.has(key)) {
            try {
              const response = await cncTelegramApi.searchMdfBoardHistoryOrders(name, 5, { cache: 'no-store' });
              const match = response.data.find((order) => order.orderName.trim().toLocaleLowerCase('ru-RU') === key)
                ?? response.data[0] ?? null;
              resolvedNamesRef.current.set(key, match?.orderId ?? null);
            } catch {
              resolvedNamesRef.current.set(key, null);
            }
          }
          // A newer call already superseded this one (and applied its own, current selection) —
          // abandon the rest of this resolution rather than racing it.
          if (searchRequestSeqRef.current !== seq) return;
        }
        const resolvedPlan = planMdfPublishedSearchOrderIds({
          requestedOrderNames: names,
          knownOrders: sessionRef.current?.snapshot.orders ?? [],
          resolvedOrderIds: resolvedNamesRef.current,
          currentSearchOrderIds: searchOrderIdsRef.current,
        });
        if (resolvedPlan.nextSearchOrderIds !== null) setSearchOrderIds(resolvedPlan.nextSearchOrderIds);
      } finally {
        pendingResolutionCountRef.current -= 1;
        if (pendingResolutionCountRef.current === 0) setSearchResolving(false);
      }
    })();
  }, []);

  // Kept while hidden, but never across a re-login or a permission/scope change: such data is dropped at once.
  const shownSession = session && session.sessionGeneration === authSession.getSessionGeneration() ? session : null;
  return { mode, session: shownSession, loading, settledQueryKey, searchOrderIds, searchResolving, refresh, requestSearchOrderNames };
}
