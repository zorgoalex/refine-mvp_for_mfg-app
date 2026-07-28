import type { CutJobDto } from '../../api/types/cutApi.types';

export const CUT_JOB_READY_EVENT = 'erp:cut-job-ready';

export interface CutJobReadyEventPayload {
  cutJobId: number;
  name: string;
  detailIds: number[];
  orderIds: number[];
}

export function buildCutJobReadyPayload(job: Pick<CutJobDto, 'cutJobId' | 'name' | 'items'>): CutJobReadyEventPayload {
  return {
    cutJobId: job.cutJobId,
    name: job.name,
    detailIds: uniquePositiveIntegers(job.items.map((item) => item.orderDetailId)),
    orderIds: uniquePositiveIntegers(job.items.map((item) => item.orderId)),
  };
}

export function emitCutJobReady(job: Pick<CutJobDto, 'cutJobId' | 'name' | 'items'>): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CUT_JOB_READY_EVENT, { detail: buildCutJobReadyPayload(job) }));
}

export function readCutJobReadyEvent(event: Event): CutJobReadyEventPayload | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isCutJobReadyEventPayload(detail)) return null;
  return detail;
}

export function cutJobReadyAffects(
  payload: CutJobReadyEventPayload,
  target: { detailIds?: readonly number[]; orderId?: number | null },
): boolean {
  if (target.orderId != null && payload.orderIds.includes(target.orderId)) return true;
  if (!target.detailIds || target.detailIds.length === 0) return false;
  const affected = new Set(payload.detailIds);
  return target.detailIds.some((detailId) => affected.has(detailId));
}

function uniquePositiveIntegers(values: readonly unknown[]): number[] {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
}

function isCutJobReadyEventPayload(value: unknown): value is CutJobReadyEventPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as CutJobReadyEventPayload;
  return Number.isInteger(payload.cutJobId)
    && payload.cutJobId > 0
    && typeof payload.name === 'string'
    && Array.isArray(payload.detailIds)
    && Array.isArray(payload.orderIds);
}
