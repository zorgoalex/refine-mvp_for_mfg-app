import type { CutDetailLastReadyRef } from '../../api/types/cutApi.types';

/** Map detail id → its latest-created ready cut job ref (one ref per detail). */
export function buildCutJobByDetailId(
  refs: CutDetailLastReadyRef[],
): Map<number, CutDetailLastReadyRef> {
  const map = new Map<number, CutDetailLastReadyRef>();
  for (const ref of refs) map.set(ref.orderDetailId, ref);
  return map;
}

/** Deep-link to the cut page opened on a specific job. */
export function cutJobDeepLink(cutJobId: number): string {
  return `/cut?job=${cutJobId}`;
}
