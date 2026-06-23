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
// Deep-link straight to the Orders (ErpOrder) records view so CRM opens on
// Заказы instead of Twenty's default (Companies / last visited). Set
// VITE_CRM_PATH='' to open the CRM root instead.
const DEFAULT_CRM_PATH = '/objects/erpOrders';

/**
 * Resolve the CRM menu config from the environment.
 * The opened URL is VITE_CRM_URL (origin) + VITE_CRM_PATH (deep link).
 * Returns null when no usable URL is configured (link hidden):
 *  - VITE_CRM_URL explicitly empty, or
 *  - the value is not an http(s) URL.
 */
export function getCrmMenuConfig(
  env: EnvSource = ((import.meta as { env?: EnvSource }).env ?? {}),
): CrmMenuConfig | null {
  const base = (env.VITE_CRM_URL ?? DEFAULT_CRM_URL).trim();
  if (!base) return null; // explicitly disabled
  if (!/^https?:\/\//i.test(base)) return null; // guard against a malformed value
  const path = (env.VITE_CRM_PATH ?? DEFAULT_CRM_PATH).trim();
  const url = path
    ? `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    : base;
  const label = (env.VITE_CRM_LABEL ?? '').trim() || DEFAULT_CRM_LABEL;
  return { url, label };
}

export const crmMenuConfig = getCrmMenuConfig();

/** Minimal DOM surface needed to inject resource hints (eases testing). */
type HintDocument = Pick<Document, 'head' | 'createElement' | 'querySelector'>;

/**
 * Inject one-time resource hints so the first CRM open is a little faster while
 * the user is already in ERP: warm DNS/TLS to the CRM origin (dns-prefetch +
 * preconnect). Idempotent — re-calling does nothing once the hints exist.
 *
 * NOTE: we intentionally do NOT inject `<link rel="prefetch" as="document">` for
 * the full CRM URL. That document prefetch is a cross-origin fetch governed by
 * the app CSP `default-src 'self'`, so the browser refuses it and logs a CSP
 * violation on every page carrying the CRM menu. dns-prefetch/preconnect are
 * connection hints (not fetch directives) → they warm the connection without
 * tripping CSP. The CRM still opens fine: top-level navigation to the new tab is
 * not restricted by connect-src/default-src.
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
