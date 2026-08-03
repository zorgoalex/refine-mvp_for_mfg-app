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

export function buildCutJobLinkMapsFromDetails(
  details: readonly unknown[],
): {
  cutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
} {
  const cutJobByDetailId = new Map<number, CutDetailLastReadyJobRef>();
  const bathCutJobByDetailId = new Map<number, CutDetailLastReadyJobRef>();
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const row = detail as Record<string, unknown>;
    const detailId = normalizePositiveInteger(row.detail_id ?? row.detailId ?? row.id);
    if (detailId == null) continue;
    const cutJob = normalizeCutJobRef(row.cut_job ?? row.cutJob);
    const bathCutJob = normalizeCutJobRef(row.bath_cut_job ?? row.bathCutJob);
    if (cutJob) cutJobByDetailId.set(detailId, cutJob);
    if (bathCutJob) bathCutJobByDetailId.set(detailId, bathCutJob);
  }
  return { cutJobByDetailId, bathCutJobByDetailId };
}

export function mergeCutJobLinkMaps(
  base: {
    cutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
    bathCutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  },
  override: {
    cutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
    bathCutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  },
): {
  cutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: Map<number, CutDetailLastReadyJobRef>;
} {
  const cutJobByDetailId = new Map(base.cutJobByDetailId);
  const bathCutJobByDetailId = new Map(base.bathCutJobByDetailId);
  for (const [detailId, ref] of override.cutJobByDetailId) cutJobByDetailId.set(detailId, ref);
  for (const [detailId, ref] of override.bathCutJobByDetailId) bathCutJobByDetailId.set(detailId, ref);
  return { cutJobByDetailId, bathCutJobByDetailId };
}

function normalizeCutJobRef(value: unknown): CutDetailLastReadyJobRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as Record<string, unknown>;
  const cutJobId = normalizePositiveInteger(ref.cutJobId);
  const resultNo = normalizePositiveInteger(ref.resultNo);
  if (cutJobId == null || resultNo == null) return null;
  const rawCutNumber = typeof ref.cutNumber === 'string' ? ref.cutNumber.trim() : '';
  return {
    cutJobId,
    resultNo,
    cutNumber: rawCutNumber || `${cutJobId}-${resultNo}`,
    name: typeof ref.name === 'string' && ref.name.trim() ? ref.name : `Раскрой ${cutJobId}`,
    paramProfileId: normalizeNullableInteger(ref.paramProfileId),
    profileName: typeof ref.profileName === 'string' ? ref.profileName : null,
    profileIsActive: typeof ref.profileIsActive === 'boolean' ? ref.profileIsActive : null,
  };
}

function normalizePositiveInteger(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  return Number.isInteger(numberValue) ? numberValue : null;
}

export function areCutJobLinkMapsEqual(
  left: {
    cutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
    bathCutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  },
  right: {
    cutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
    bathCutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  },
): boolean {
  return areCutJobRefMapsEqual(left.cutJobByDetailId, right.cutJobByDetailId)
    && areCutJobRefMapsEqual(left.bathCutJobByDetailId, right.bathCutJobByDetailId);
}

function areCutJobRefMapsEqual(
  left: ReadonlyMap<number, CutDetailLastReadyJobRef>,
  right: ReadonlyMap<number, CutDetailLastReadyJobRef>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [detailId, leftRef] of left.entries()) {
    const rightRef = right.get(detailId);
    if (
      !rightRef
      || leftRef.cutJobId !== rightRef.cutJobId
      || leftRef.resultNo !== rightRef.resultNo
      || leftRef.cutNumber !== rightRef.cutNumber
      || leftRef.name !== rightRef.name
      || leftRef.paramProfileId !== rightRef.paramProfileId
      || leftRef.profileName !== rightRef.profileName
      || leftRef.profileIsActive !== rightRef.profileIsActive
    ) {
      return false;
    }
  }
  return true;
}

export function buildOrderDetailLiveCellRenderVersion(input: {
  currentDetailProductionStatusById: ReadonlyMap<number, number | null>;
  productionStatusesById: ReadonlyMap<number, { name: string; color?: string | null }>;
  productionStatusesLoading: boolean;
  cutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
  bathCutJobByDetailId: ReadonlyMap<number, CutDetailLastReadyJobRef>;
}): string {
  const sortedEntries = <T>(map: ReadonlyMap<number, T>) => (
    [...map.entries()].sort(([left], [right]) => left - right)
  );

  return [
    sortedEntries(input.currentDetailProductionStatusById)
      .map(([detailId, statusId]) => `${detailId}:${statusId ?? ''}`)
      .join(','),
    sortedEntries(input.productionStatusesById)
      .map(([statusId, meta]) => `${statusId}:${meta.name}:${meta.color ?? ''}`)
      .join(','),
    input.productionStatusesLoading ? 'status-loading' : 'status-ready',
    JSON.stringify(sortedEntries(input.cutJobByDetailId)),
    JSON.stringify(sortedEntries(input.bathCutJobByDetailId)),
  ].join('|');
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
