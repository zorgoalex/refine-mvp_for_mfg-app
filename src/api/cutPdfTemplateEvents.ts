const CUT_PDF_TEMPLATE_CHANGED_EVENT = 'erp:cut-pdf-template-changed';
const CUT_PDF_TEMPLATE_CHANGED_STORAGE_KEY = 'erp.cutPdfTemplate.changedAt';
const CUT_PDF_TEMPLATE_CHANGED_CHANNEL = 'erp-cut-pdf-template-events';

let channel: BroadcastChannel | null = null;

export function notifyCutPdfTemplatesChanged(): void {
  if (typeof window === 'undefined') return;
  const payload = { type: CUT_PDF_TEMPLATE_CHANGED_EVENT, at: Date.now() };
  window.dispatchEvent(new CustomEvent(CUT_PDF_TEMPLATE_CHANGED_EVENT, { detail: payload }));
  try {
    window.localStorage.setItem(CUT_PDF_TEMPLATE_CHANGED_STORAGE_KEY, String(payload.at));
  } catch {
    // localStorage can be unavailable in private mode; same-window event still works.
  }
  ensureCutPdfTemplateChannel()?.postMessage(payload);
}

export function subscribeCutPdfTemplatesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onWindowEvent = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUT_PDF_TEMPLATE_CHANGED_STORAGE_KEY) listener();
  };
  const onChannel = (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === CUT_PDF_TEMPLATE_CHANGED_EVENT) listener();
  };

  window.addEventListener(CUT_PDF_TEMPLATE_CHANGED_EVENT, onWindowEvent);
  window.addEventListener('storage', onStorage);
  const currentChannel = ensureCutPdfTemplateChannel();
  currentChannel?.addEventListener('message', onChannel);

  return () => {
    window.removeEventListener(CUT_PDF_TEMPLATE_CHANGED_EVENT, onWindowEvent);
    window.removeEventListener('storage', onStorage);
    currentChannel?.removeEventListener('message', onChannel);
  };
}

function ensureCutPdfTemplateChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CUT_PDF_TEMPLATE_CHANGED_CHANNEL);
  return channel;
}
