import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cutApi } from '../../api/cutApi';
import type { CutDetailLastReadyJobRef } from '../../api/types/cutApi.types';
import {
  cutJobReadyAffects,
  subscribeCutJobReady,
} from '../cut/cutJobEvents';
import { buildCutJobLinkMaps } from './cutColumnHelpers';

interface UseCutDetailLastReadyArgs {
  enabled: boolean;
  detailIds: readonly unknown[];
  orderId?: number | null;
}

export interface CutDetailLastReadyMaps {
  cutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
}

const EMPTY_CUT_DETAIL_LAST_READY_MAPS: CutDetailLastReadyMaps = {
  cutJobByDetailId: new Map(),
  bathCutJobByDetailId: new Map(),
};

export function useCutDetailLastReady({
  enabled,
  detailIds,
  orderId,
}: UseCutDetailLastReadyArgs): CutDetailLastReadyMaps {
  const [cutJobMaps, setCutJobMaps] = useState<CutDetailLastReadyMaps>(
    () => EMPTY_CUT_DETAIL_LAST_READY_MAPS,
  );
  const normalizedDetailIds = useMemo(() => normalizeCutDetailIds(detailIds), [detailIds]);
  const detailIdsKey = normalizedDetailIds.join(',');
  const detailIdsRef = useRef<number[]>(normalizedDetailIds);
  const orderIdRef = useRef<number | null | undefined>(orderId);

  useEffect(() => {
    detailIdsRef.current = normalizedDetailIds;
    orderIdRef.current = orderId;
  }, [detailIdsKey, orderId]);

  const refresh = useCallback(async (ids: readonly number[] = detailIdsRef.current) => {
    if (!enabled || ids.length === 0) {
      setCutJobMaps(EMPTY_CUT_DETAIL_LAST_READY_MAPS);
      return;
    }
    try {
      const res = await cutApi.listDetailLastReady([...ids]);
      setCutJobMaps(buildCutJobLinkMaps(res.details));
    } catch {
      setCutJobMaps(EMPTY_CUT_DETAIL_LAST_READY_MAPS);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh(detailIdsRef.current);
  }, [detailIdsKey, enabled, refresh]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const unsubscribe = subscribeCutJobReady((payload) => {
      if (!cutJobReadyAffects(payload, { detailIds: detailIdsRef.current, orderId: orderIdRef.current })) return;
      void refresh(detailIdsRef.current);
    });
    const refreshOnFocus = () => {
      void refresh(detailIdsRef.current);
    };
    window.addEventListener('focus', refreshOnFocus);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [enabled, refresh]);

  return cutJobMaps;
}

export function normalizeCutDetailIds(detailIds: readonly unknown[]): number[] {
  return Array.from(
    new Set(
      detailIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
}
