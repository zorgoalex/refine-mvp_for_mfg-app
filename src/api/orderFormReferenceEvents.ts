export const ORDER_FORM_REFERENCE_CHANGED_EVENT = 'erp:order-form-reference-changed';

const ORDER_FORM_REFERENCE_CHANGED_STORAGE_KEY = 'erp.orderFormReference.changed';
const ORDER_FORM_REFERENCE_CHANGED_CHANNEL = 'erp-order-form-reference-events';

const ORDER_FORM_REFERENCE_RESOURCES = new Set([
  'clients',
  'materials',
  'milling_types',
  'edge_types',
  'films',
  'order_statuses',
  'payment_statuses',
  'payment_types',
  'production_statuses',
  'workshops',
  'employees',
  'units',
  'sheet_material_types',
]);

export interface OrderFormReferenceChangedPayload {
  type: typeof ORDER_FORM_REFERENCE_CHANGED_EVENT;
  eventId: string;
  resource: string;
  at: number;
}

let channel: BroadcastChannel | null = null;
let eventSequence = 0;

export function isOrderFormReferenceResource(resource: string): boolean {
  return ORDER_FORM_REFERENCE_RESOURCES.has(resource);
}

export function notifyOrderFormReferencesChanged(resource: string): void {
  if (!isOrderFormReferenceResource(resource) || typeof window === 'undefined') return;

  const at = Date.now();
  const payload: OrderFormReferenceChangedPayload = {
    type: ORDER_FORM_REFERENCE_CHANGED_EVENT,
    eventId: `${at}-${eventSequence += 1}-${resource}`,
    resource,
    at,
  };

  window.dispatchEvent(new CustomEvent(ORDER_FORM_REFERENCE_CHANGED_EVENT, { detail: payload }));

  try {
    window.localStorage.setItem(
      ORDER_FORM_REFERENCE_CHANGED_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Same-window event still works when browser storage is unavailable.
  }

  ensureChannel()?.postMessage(payload);
}

export function subscribeOrderFormReferencesChanged(
  listener: (payload: OrderFormReferenceChangedPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  let lastEventId: string | null = null;
  const deliver = (value: unknown) => {
    const payload = parsePayload(value);
    if (!payload || payload.eventId === lastEventId) return;
    lastEventId = payload.eventId;
    listener(payload);
  };
  const onWindowEvent = (event: Event) => {
    deliver((event as CustomEvent<unknown>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ORDER_FORM_REFERENCE_CHANGED_STORAGE_KEY || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue));
    } catch {
      // Ignore corrupt/non-ERP storage payloads.
    }
  };
  const onChannel = (event: MessageEvent<unknown>) => {
    deliver(event.data);
  };

  window.addEventListener(ORDER_FORM_REFERENCE_CHANGED_EVENT, onWindowEvent);
  window.addEventListener('storage', onStorage);
  const currentChannel = ensureChannel();
  currentChannel?.addEventListener('message', onChannel);

  return () => {
    window.removeEventListener(ORDER_FORM_REFERENCE_CHANGED_EVENT, onWindowEvent);
    window.removeEventListener('storage', onStorage);
    currentChannel?.removeEventListener('message', onChannel);
  };
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(ORDER_FORM_REFERENCE_CHANGED_CHANNEL);
  return channel;
}

function parsePayload(value: unknown): OrderFormReferenceChangedPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<OrderFormReferenceChangedPayload>;
  if (
    payload.type !== ORDER_FORM_REFERENCE_CHANGED_EVENT
    || typeof payload.eventId !== 'string'
    || typeof payload.resource !== 'string'
    || !isOrderFormReferenceResource(payload.resource)
    || typeof payload.at !== 'number'
    || !Number.isFinite(payload.at)
  ) {
    return null;
  }
  return payload as OrderFormReferenceChangedPayload;
}
