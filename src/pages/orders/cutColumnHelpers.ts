import type { CutDetailLastReadyJobRef, CutDetailLastReadyRef, CutJobRef } from '../../api/types/cutApi.types';

/** Map detail id → its latest-created ready cut job ref (one ref per detail). */
export function buildCutJobByDetailId(
  refs: CutDetailLastReadyRef[],
): Map<number, CutDetailLastReadyJobRef> {
  return buildCutJobLinkMaps(refs).cutJobByDetailId;
}

export function buildCutJobLinkMaps(
  refs: CutDetailLastReadyRef[],
): {
  cutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
} {
  const cutJobByDetailId = new Map<number, CutDetailLastReadyJobRef>();
  const bathCutJobByDetailId = new Map<number, CutDetailLastReadyJobRef>();
  for (const ref of refs) {
    if (ref.cutJob) cutJobByDetailId.set(ref.orderDetailId, ref.cutJob);
    if (ref.bathCutJob) bathCutJobByDetailId.set(ref.orderDetailId, ref.bathCutJob);
  }
  return { cutJobByDetailId, bathCutJobByDetailId };
}

/** Deep-link to the cut page opened on a specific job/result. */
export function cutJobDeepLink(cutJobId: number, resultNo?: number | null): string;
export function cutJobDeepLink(ref: Pick<CutDetailLastReadyJobRef, 'cutJobId' | 'resultNo'>): string;
export function cutJobDeepLink(
  cutJobOrRef: number | Pick<CutDetailLastReadyJobRef, 'cutJobId' | 'resultNo'>,
  resultNo?: number | null,
): string {
  const cutJobId = typeof cutJobOrRef === 'number' ? cutJobOrRef : cutJobOrRef.cutJobId;
  const resolvedResultNo = typeof cutJobOrRef === 'number' ? resultNo : cutJobOrRef.resultNo;
  const params = new URLSearchParams({ job: String(cutJobId) });
  if (resolvedResultNo != null) params.set('result', String(resolvedResultNo));
  return `/cut?${params.toString()}`;
}

/** User-facing current/acting cut result number for order detail columns. */
export function cutJobVersionLabel(
  ref: Pick<CutDetailLastReadyJobRef, 'cutJobId' | 'resultNo' | 'cutNumber'>,
): string {
  const cutNumber = ref.cutNumber.trim();
  return cutNumber || `${ref.cutJobId}-${ref.resultNo}`;
}

/** Human-readable cut profile label for order-facing cut job refs. */
export function cutJobProfileLabel(job: Pick<CutJobRef, 'paramProfileId' | 'profileName' | 'profileIsActive'>): string {
  const profileName = job.profileName?.trim();
  if (profileName) {
    return job.profileIsActive === false ? `${profileName} (неактивен)` : profileName;
  }
  return job.paramProfileId != null ? `Профиль #${job.paramProfileId}` : 'По умолчанию';
}
