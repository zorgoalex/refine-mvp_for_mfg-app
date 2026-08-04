export const LABEL_TEMPLATE_CHANGED_EVENT = 'erp:label-template-changed';

const LABEL_TEMPLATE_CHANGED_STORAGE_KEY = 'erp.labelTemplate.changed';
const LABEL_TEMPLATE_CHANGED_CHANNEL = 'erp-label-template-events';

export interface LabelTemplateChangedPayload {
  eventId: string;
  templateId: number;
  version: number;
  changedAt: number;
}

let channel: BroadcastChannel | null = null;
let eventSequence = 0;

export function notifyLabelTemplateChanged(template: { labelTemplateId: number; version: number }): void {
  if (typeof window === 'undefined') return;
  const changedAt = Date.now();
  const payload: LabelTemplateChangedPayload = {
    eventId: `${changedAt}-${eventSequence += 1}-${template.labelTemplateId}-${template.version}`,
    templateId: template.labelTemplateId,
    version: template.version,
    changedAt,
  };

  window.dispatchEvent(new CustomEvent(LABEL_TEMPLATE_CHANGED_EVENT, { detail: payload }));
  try {
    window.localStorage.setItem(LABEL_TEMPLATE_CHANGED_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Same-window delivery still works when browser storage is unavailable.
  }
  ensureChannel()?.postMessage(payload);
}

export function subscribeLabelTemplateChanged(
  listener: (payload: LabelTemplateChangedPayload) => void,
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
    if (event.key !== LABEL_TEMPLATE_CHANGED_STORAGE_KEY || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue));
    } catch {
      // Ignore corrupt/non-ERP storage payloads.
    }
  };
  const onChannel = (event: MessageEvent<unknown>) => {
    deliver(event.data);
  };

  window.addEventListener(LABEL_TEMPLATE_CHANGED_EVENT, onWindowEvent);
  window.addEventListener('storage', onStorage);
  const currentChannel = ensureChannel();
  currentChannel?.addEventListener('message', onChannel);

  return () => {
    window.removeEventListener(LABEL_TEMPLATE_CHANGED_EVENT, onWindowEvent);
    window.removeEventListener('storage', onStorage);
    currentChannel?.removeEventListener('message', onChannel);
  };
}

function parsePayload(value: unknown): LabelTemplateChangedPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<LabelTemplateChangedPayload>;
  if (
    typeof payload.eventId !== 'string'
    || !Number.isInteger(payload.templateId)
    || Number(payload.templateId) <= 0
    || !Number.isInteger(payload.version)
    || Number(payload.version) <= 0
    || !Number.isFinite(payload.changedAt)
  ) {
    return null;
  }
  return payload as LabelTemplateChangedPayload;
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(LABEL_TEMPLATE_CHANGED_CHANNEL);
  return channel;
}
