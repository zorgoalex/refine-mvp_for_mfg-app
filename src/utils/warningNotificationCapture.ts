const WARNING_MARKER_SELECTOR = [
  '.ant-alert-warning',
  '.ant-message-warning',
  '.ant-modal-confirm-warning',
  '.ant-notification-notice-icon-warning',
  '.ant-form-item-explain-warning',
  '.ant-typography-warning',
].join(',');

type WarningListener = (message: string) => void;

export function observeUserWarnings(
  root: HTMLElement,
  onWarning: WarningListener,
): () => void {
  const capturedText = new WeakMap<Element, string>();

  const captureMarker = (marker: Element) => {
    const warningElement = resolveWarningElement(marker);
    const message = warningText(warningElement);
    if (!message || capturedText.get(warningElement) === message) {
      return;
    }

    capturedText.set(warningElement, message);
    onWarning(message);
  };

  const scan = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const marker = node.parentElement?.closest(WARNING_MARKER_SELECTOR);
      if (marker) captureMarker(marker);
      return;
    }

    if (!(node instanceof Element)) return;
    if (node.matches(WARNING_MARKER_SELECTOR)) captureMarker(node);
    node.querySelectorAll(WARNING_MARKER_SELECTOR).forEach(captureMarker);

    const containingMarker = node.closest(WARNING_MARKER_SELECTOR);
    if (containingMarker) captureMarker(containingMarker);
  };

  scan(root);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        scan(mutation.target);
        continue;
      }
      mutation.addedNodes.forEach(scan);
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return () => observer.disconnect();
}

export function warningText(element: Element): string {
  const preferredParts = [
    '.ant-alert-message',
    '.ant-alert-description',
    '.ant-notification-notice-message',
    '.ant-notification-notice-description',
    '.ant-modal-confirm-title',
    '.ant-modal-confirm-content',
  ]
    .map((selector) => element.querySelector(selector)?.textContent);

  return formatWarningText(preferredParts, element.textContent);
}

export function formatWarningText(
  preferredParts: Array<string | null | undefined>,
  fallback: string | null | undefined,
): string {
  const normalizedParts = preferredParts
    .map(normalizeText)
    .filter((value): value is string => Boolean(value));

  return unique(normalizedParts).join(': ') || normalizeText(fallback) || '';
}

function resolveWarningElement(marker: Element): Element {
  if (marker.classList.contains('ant-notification-notice-icon-warning')) {
    return marker.closest('.ant-notification-notice') ?? marker;
  }
  return marker;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
