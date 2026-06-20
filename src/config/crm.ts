/**
 * CRM (Twenty) menu-link configuration.
 *
 * The ERP sider shows a single external link to the Twenty CRM workspace for
 * logged-in users (the sider only renders inside the authenticated layout).
 * The URL is build-time configurable so stage points at crm-test and prod can
 * point at the production CRM host; set VITE_CRM_URL='' to hide the link.
 */
export interface CrmMenuConfig {
  url: string;
  label: string;
}

type EnvSource = Record<string, string | undefined>;

const DEFAULT_CRM_URL = 'https://crm-test.mebelkz.app';
const DEFAULT_CRM_LABEL = 'CRM';

/**
 * Resolve the CRM menu config from the environment.
 * Returns null when no usable URL is configured (link hidden):
 *  - VITE_CRM_URL explicitly empty, or
 *  - the value is not an http(s) URL.
 */
export function getCrmMenuConfig(
  env: EnvSource = ((import.meta as { env?: EnvSource }).env ?? {}),
): CrmMenuConfig | null {
  const raw = env.VITE_CRM_URL;
  const url = (raw ?? DEFAULT_CRM_URL).trim();
  if (!url) return null; // explicitly disabled
  if (!/^https?:\/\//i.test(url)) return null; // guard against a malformed value
  const label = (env.VITE_CRM_LABEL ?? '').trim() || DEFAULT_CRM_LABEL;
  return { url, label };
}

export const crmMenuConfig = getCrmMenuConfig();

/** Minimal DOM surface needed to inject resource hints (eases testing). */
type HintDocument = Pick<Document, 'head' | 'createElement' | 'querySelector'>;

/**
 * Inject one-time resource hints so the first CRM open is a little faster while
 * the user is already in ERP: warm DNS/TLS to the CRM origin (preconnect) and
 * prefetch its document. Idempotent — re-calling does nothing once the hints
 * exist. Cross-origin limits how much can be prewarmed (the heavy hashed JS
 * lives on another origin), so this trims connection setup, not the SPA parse.
 */
export function ensureCrmResourceHints(
  url: string,
  doc: HintDocument | undefined = typeof document !== 'undefined' ? document : undefined,
): void {
  if (!doc || !url) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  const hints: Array<{ rel: string; href: string; crossOrigin?: boolean; as?: string }> = [
    { rel: 'dns-prefetch', href: origin },
    { rel: 'preconnect', href: origin, crossOrigin: true },
    { rel: 'prefetch', href: url, as: 'document' },
  ];
  for (const hint of hints) {
    if (doc.querySelector(`link[data-crm-hint="${hint.rel}"]`)) continue;
    const link = doc.createElement('link');
    link.rel = hint.rel;
    link.href = hint.href;
    if (hint.crossOrigin) link.crossOrigin = '';
    if (hint.as) link.setAttribute('as', hint.as);
    link.setAttribute('data-crm-hint', hint.rel);
    doc.head.appendChild(link);
  }
}
