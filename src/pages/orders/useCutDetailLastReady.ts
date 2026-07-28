import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cutApi } from '../../api/cutApi';
import type { CutDetailLastReadyRef } from '../../api/types/cutApi.types';
import {
  CUT_JOB_READY_EVENT,
  cutJobReadyAffects,
  readCutJobReadyEvent,
} from '../cut/cutJobEvents';
import { buildCutJobByDetailId } from './cutColumnHelpers';

interface UseCutDetailLastReadyArgs {
  enabled: boolean;
  detailIds: readonly unknown[];
  orderId?: number | null;
}

export function useCutDetailLastReady({
  enabled,
  detailIds,
  orderId,
}: UseCutDetailLastReadyArgs): Map<number, CutDetailLastReadyRef> {
  const [cutJobByDetailId, setCutJobByDetailId] = useState<Map<number, CutDetailLastReadyRef>>(
    () => new Map(),
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
      setCutJobByDetailId(new Map());
      return;
    }
    try {
      const res = await cutApi.listDetailLastReady([...ids]);
      setCutJobByDetailId(buildCutJobByDetailId(res.details));
    } catch {
      setCutJobByDetailId(new Map());
    }
  }, [enabled]);

  useEffect(() => {
    void refresh(detailIdsRef.current);
  }, [detailIdsKey, enabled, refresh]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const handler = (event: Event) => {
      const payload = readCutJobReadyEvent(event);
      if (!payload) return;
      if (!cutJobReadyAffects(payload, { detailIds: detailIdsRef.current, orderId: orderIdRef.current })) return;
      void refresh(detailIdsRef.current);
    };
    window.addEventListener(CUT_JOB_READY_EVENT, handler);
    return () => {
      window.removeEventListener(CUT_JOB_READY_EVENT, handler);
    };
  }, [enabled, refresh]);

  return cutJobByDetailId;
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
