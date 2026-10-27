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
import { takePrefetchedMdfEngineMode, takePrefetchedMdfSnapshot } from '../../api/mdfBoardOpenPrefetch';
import { selectMdfBoardMode, type MdfBoardMode, type MdfEngineModeFetchResult } from './mdfBoardMode';
import { isMdfEngineModeEndpointMissing } from './mdfReturnSelection';
import { planMdfPublishedSearchOrderIds } from './mdfPublishedBoard';
import { buildCncOrderSearchDateRange, type CncOrderSearchPeriod } from './model';

const POLL_INTERVAL_MS = 15000;

export interface UseMdfPublishedBoardParams {
  /** `active && isCncToday`. When false the hook tears its state down and does no IO. */
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
}

export interface UseMdfPublishedBoardResult {
  /** null while the engine mode has not been resolved yet (first load). */
  mode: MdfBoardMode | null;
  session: MdfSessionSnapshot | null;
  loading: boolean;
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

export function useMdfPublishedBoard(params: UseMdfPublishedBoardParams): UseMdfPublishedBoardResult {
  const { enabled, workday, period, focusKind, focusId } = params;
  const orderIdsKey = (params.orderIds ?? []).slice(0, 100).join(',');
  const [mode, setMode] = useState<MdfBoardMode | null>(null);
  const modeRef = useRef<MdfBoardMode | null>(null);
  modeRef.current = mode;
  const [session, setSession] = useState<MdfSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchOrderIds, setSearchOrderIds] = useState<number[]>([]);
  const [searchResolving, setSearchResolving] = useState(false);

  const generationRef = useRef<MdfBoardGenerationState>(createMdfBoardGenerationState());
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

  const runCycle = useCallback(async (requestGeneration: number) => {
    setLoading(true);
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
    const earlyRead = modeRef.current === 'legacy' ? null
      : (plainQuery ? takePrefetchedMdfSnapshot({ dateTo: workday, displayFrom }) : null) ?? readPublished();
    earlyRead?.catch(() => undefined);
    let engineModeFetch: MdfEngineModeFetchResult;
    try {
      const engineMode = await (takePrefetchedMdfEngineMode() ?? mdfCorrectionApi.getEngineMode());
      engineModeFetch = { kind: 'ok', engineMode };
    } catch (error) {
      engineModeFetch = isMdfEngineModeEndpointMissing(error) ? { kind: 'endpointMissing' } : { kind: 'error' };
    }
    if (!isMdfBoardGenerationCurrent(generationRef.current, requestGeneration) || !enabledRef.current) return;

    const needsPublishedFetch = engineModeFetch.kind === 'ok'
      && (engineModeFetch.engineMode.mode === 'active' || engineModeFetch.engineMode.mode === 'read_only')
      && engineModeFetch.engineMode.publishedReads;
    if (!needsPublishedFetch) {
      const resolvedMode = selectMdfBoardMode({ engineModeFetch, publishedReadsFailed: false });
      setMode(resolvedMode);
      setSession(null);
      setLoading(false);
      return;
    }
    let publishedReadsFailed = false;
    let nextSession: MdfSessionSnapshot | null = null;
    try {
      nextSession = await currentSessionSnapshot(earlyRead, readPublished, () => authSession.getSessionGeneration());
    } catch {
      publishedReadsFailed = true;
    }
    if (!isMdfBoardGenerationCurrent(generationRef.current, requestGeneration) || !enabledRef.current) return;
    const resolvedMode = selectMdfBoardMode({ engineModeFetch, publishedReadsFailed });
    setMode(resolvedMode);
    setSession(resolvedMode === 'published' ? nextSession : null);
    setLoading(false);
  }, [workday, period, focusKind, focusId]);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return;
    const requestGeneration = bump();
    void runCycle(requestGeneration);
  }, [bump, runCycle]);

  // Query change (workday, period — which drives `displayFrom` — focus, mode-affecting session
  // state, searchOrderIds) or enable/disable: one board-wide generation bump per change, superseded
  // responses dropped (§5.6 req 7 / R2#2).
  useEffect(() => {
    const requestGeneration = bump();
    if (!enabled) {
      setMode(null);
      setSession(null);
      setLoading(false);
      return;
    }
    void runCycle(requestGeneration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workday, period, focusKind, focusId, searchOrderIds.join(','), orderIdsKey]);

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

  return { mode, session, loading, searchOrderIds, searchResolving, refresh, requestSearchOrderNames };
}
