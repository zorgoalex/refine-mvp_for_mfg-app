import type { CutJobDto } from '../../api/types/cutApi.types';

export const CUT_JOB_READY_EVENT = 'erp:cut-job-ready';

const CUT_JOB_READY_STORAGE_KEY = 'erp.cutJobReady.changed';
const CUT_JOB_READY_CHANNEL = 'erp-cut-job-events';

export interface CutJobReadyEventPayload {
  cutJobId: number;
  name: string;
  detailIds: number[];
  orderIds: number[];
}

export interface CutJobReadyPayloadOptions {
  detailIds?: readonly unknown[];
  orderIds?: readonly unknown[];
}

interface CutJobReadyMessage {
  eventId: string;
  payload: CutJobReadyEventPayload;
}

let channel: BroadcastChannel | null = null;
let eventSequence = 0;

export function buildCutJobReadyPayload(
  job: Pick<CutJobDto, 'cutJobId' | 'name' | 'items'>,
  options: CutJobReadyPayloadOptions = {},
): CutJobReadyEventPayload {
  return {
    cutJobId: job.cutJobId,
    name: job.name,
    detailIds: uniquePositiveIntegers([
      ...job.items.map((item) => item.orderDetailId),
      ...(options.detailIds ?? []),
    ]),
    orderIds: uniquePositiveIntegers([
      ...job.items.map((item) => item.orderId),
      ...(options.orderIds ?? []),
    ]),
  };
}

export function emitCutJobReady(
  job: Pick<CutJobDto, 'cutJobId' | 'name' | 'items'>,
  options: CutJobReadyPayloadOptions = {},
): void {
  if (typeof window === 'undefined') return;
  const payload = buildCutJobReadyPayload(job, options);
  const message: CutJobReadyMessage = {
    eventId: `${Date.now()}-${eventSequence += 1}-${payload.cutJobId}`,
    payload,
  };

  window.dispatchEvent(new CustomEvent(CUT_JOB_READY_EVENT, { detail: payload }));
  try {
    window.localStorage.setItem(CUT_JOB_READY_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Same-window event still works when browser storage is unavailable.
  }
  ensureChannel()?.postMessage(message);
}

export function subscribeCutJobReady(
  listener: (payload: CutJobReadyEventPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  let lastEventId: string | null = null;
  const deliverMessage = (value: unknown) => {
    const message = parseMessage(value);
    if (!message || message.eventId === lastEventId) return;
    lastEventId = message.eventId;
    listener(message.payload);
  };
  const onWindowEvent = (event: Event) => {
    const payload = readCutJobReadyEvent(event);
    if (payload) listener(payload);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CUT_JOB_READY_STORAGE_KEY || !event.newValue) return;
    try {
      deliverMessage(JSON.parse(event.newValue));
    } catch {
      // Ignore corrupt/non-ERP storage payloads.
    }
  };
  const onChannel = (event: MessageEvent<unknown>) => {
    deliverMessage(event.data);
  };

  window.addEventListener(CUT_JOB_READY_EVENT, onWindowEvent);
  window.addEventListener('storage', onStorage);
  const currentChannel = ensureChannel();
  currentChannel?.addEventListener('message', onChannel);

  return () => {
    window.removeEventListener(CUT_JOB_READY_EVENT, onWindowEvent);
    window.removeEventListener('storage', onStorage);
    currentChannel?.removeEventListener('message', onChannel);
  };
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

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CUT_JOB_READY_CHANNEL);
  return channel;
}

function parseMessage(value: unknown): CutJobReadyMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Partial<CutJobReadyMessage>;
  if (
    typeof message.eventId !== 'string'
    || !isCutJobReadyEventPayload(message.payload)
  ) {
    return null;
  }
  return message as CutJobReadyMessage;
}
