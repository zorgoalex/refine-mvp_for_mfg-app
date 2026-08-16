import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cutApi } from '../../api/cutApi';
import type { CutDetailLastReadyJobRef } from '../../api/types/cutApi.types';
import {
  cutJobReadyAffects,
  subscribeCutJobReady,
} from '../cut/cutJobEvents';
import { useOrderLifecycleReadActive } from '../../query/orderLifecycleQueries';
import { useAuthCacheNamespace } from '../../query/authCacheNamespace';
import {
  recordAppActivityRefreshTrigger,
  useAppActivitySnapshot,
} from '../../performance/appActivityCoordinator';
import { areCutJobLinkMapsEqual, buildCutJobLinkMaps } from './cutColumnHelpers';

interface UseCutDetailLastReadyArgs {
  enabled: boolean;
  active?: boolean;
  detailIds: readonly unknown[];
  orderId?: number | null;
  pollIntervalMs?: number | null;
}

export interface CutDetailLastReadyMaps {
  cutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  loaded: boolean;
  scopeKey: string;
}

const EMPTY_CUT_DETAIL_LAST_READY_MAPS: CutDetailLastReadyMaps = {
  cutJobByDetailId: new Map(),
  bathCutJobByDetailId: new Map(),
  loaded: false,
  scopeKey: '',
};

const LOADED_EMPTY_CUT_DETAIL_LAST_READY_MAPS: CutDetailLastReadyMaps = {
  cutJobByDetailId: new Map(),
  bathCutJobByDetailId: new Map(),
  loaded: true,
  scopeKey: '',
};

export function useCutDetailLastReady({
  enabled,
  active = true,
  detailIds,
  orderId,
  pollIntervalMs,
}: UseCutDetailLastReadyArgs): CutDetailLastReadyMaps {
  const lifecycleReadActive = useOrderLifecycleReadActive();
  const { activationRevision, documentVisible } = useAppActivitySnapshot();
  const authNamespace = useAuthCacheNamespace('cut-detail-last-ready');
  const effectiveActive = active && lifecycleReadActive;
  const effectiveReadActive = effectiveActive && documentVisible;
  const [cutJobMaps, setCutJobMaps] = useState<CutDetailLastReadyMaps>(
    () => EMPTY_CUT_DETAIL_LAST_READY_MAPS,
  );
  const normalizedDetailIds = useMemo(() => normalizeCutDetailIds(detailIds), [detailIds]);
  const detailIdsKey = normalizedDetailIds.join(',');
  const readScopeKey = `${authNamespace}|details:${detailIdsKey}`;
  const detailIdsRef = useRef<number[]>(normalizedDetailIds);
  const readScopeKeyRef = useRef(readScopeKey);
  const orderIdRef = useRef<number | null | undefined>(orderId);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(effectiveActive);
  const requestsByDetailIdsRef = useRef(new Map<string, Promise<void>>());
  const handledActivationRevisionRef = useRef(activationRevision);
  const lastSuccessfulAtRef = useRef(0);

  detailIdsRef.current = normalizedDetailIds;
  readScopeKeyRef.current = readScopeKey;
  orderIdRef.current = orderId;
  enabledRef.current = enabled;
  activeRef.current = effectiveReadActive;

  const refresh = useCallback(async (ids: readonly number[] = detailIdsRef.current) => {
    const detailKey = ids.join(',');
    const requestKey = readScopeKeyRef.current;
    if (!enabledRef.current || ids.length === 0) {
      const nextMaps = {
        ...LOADED_EMPTY_CUT_DETAIL_LAST_READY_MAPS,
        scopeKey: requestKey,
      };
      setCutJobMaps((current) => (
        current.loaded
          && current.scopeKey === requestKey
          && areCutJobLinkMapsEqual(current, nextMaps)
          ? current
          : nextMaps
      ));
      return;
    }
    if (!activeRef.current) return;
    const pendingRequest = requestsByDetailIdsRef.current.get(requestKey);
    if (pendingRequest) return pendingRequest;

    let request: Promise<void>;
    request = (async () => {
      try {
        const res = await cutApi.listDetailLastReady([...ids]);
        if (
          !enabledRef.current
          || !activeRef.current
          || detailIdsRef.current.join(',') !== detailKey
          || readScopeKeyRef.current !== requestKey
        ) return;
        lastSuccessfulAtRef.current = Date.now();
        const nextMaps = {
          ...buildCutJobLinkMaps(res.details),
          loaded: true,
          scopeKey: requestKey,
        };
        setCutJobMaps((current) => (
          current.loaded
            && current.scopeKey === requestKey
            && areCutJobLinkMapsEqual(current, nextMaps)
            ? current
            : nextMaps
        ));
      } catch {
        // Keep last ready versions visible; focus/event/poll can recover.
      } finally {
        if (requestsByDetailIdsRef.current.get(requestKey) === request) {
          requestsByDetailIdsRef.current.delete(requestKey);
        }
      }
    })();
    requestsByDetailIdsRef.current.set(requestKey, request);
    return request;
  }, []);

  useEffect(() => {
    if (!effectiveReadActive) return;
    if (cutJobMaps.scopeKey === readScopeKey && cutJobMaps.loaded) return;
    void refresh(detailIdsRef.current);
  }, [cutJobMaps.loaded, cutJobMaps.scopeKey, effectiveReadActive, enabled, readScopeKey, refresh]);

  useEffect(() => {
    if (!enabled || !effectiveReadActive) return undefined;
    const unsubscribe = subscribeCutJobReady((payload) => {
      if (!cutJobReadyAffects(payload, { detailIds: detailIdsRef.current, orderId: orderIdRef.current })) return;
      void refresh(detailIdsRef.current);
    });
    return unsubscribe;
  }, [effectiveReadActive, enabled, refresh]);

  useEffect(() => {
    if (handledActivationRevisionRef.current === activationRevision) return;
    handledActivationRevisionRef.current = activationRevision;
    if (!enabled || !effectiveReadActive || detailIdsRef.current.length === 0) return;
    const staleAfterMs = typeof pollIntervalMs === 'number' && Number.isFinite(pollIntervalMs)
      ? Math.max(1_000, pollIntervalMs)
      : 15_000;
    if (Date.now() - lastSuccessfulAtRef.current < staleAfterMs) return;
    if (requestsByDetailIdsRef.current.has(readScopeKeyRef.current)) return;
    recordAppActivityRefreshTrigger();
    void refresh(detailIdsRef.current);
  }, [activationRevision, effectiveReadActive, enabled, pollIntervalMs, refresh]);

  useEffect(() => {
    if (
      !enabled
      || !effectiveActive
      || typeof pollIntervalMs !== 'number'
      || !Number.isFinite(pollIntervalMs)
      || pollIntervalMs < 1_000
      || typeof window === 'undefined'
      || !documentVisible
    ) {
      return undefined;
    }

    const refreshWhenVisible = () => {
      if (requestsByDetailIdsRef.current.has(readScopeKeyRef.current)) return;
      recordAppActivityRefreshTrigger();
      void refresh(detailIdsRef.current);
    };
    const intervalId = window.setInterval(refreshWhenVisible, pollIntervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [documentVisible, effectiveActive, enabled, pollIntervalMs, refresh]);

  return cutJobMaps.scopeKey === readScopeKey
    ? cutJobMaps
    : EMPTY_CUT_DETAIL_LAST_READY_MAPS;
}

export function normalizeCutDetailIds(detailIds: readonly unknown[]): number[] {
  return Array.from(
    new Set(
      detailIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ).sort((left, right) => left - right);
}
