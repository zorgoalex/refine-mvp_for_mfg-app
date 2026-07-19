/**
 * Bitrix24 menu-link configuration.
 *
 * ERP shows a direct external link to the organization's Bitrix24 portal for
 * logged-in users. Bitrix24 owns its browser session: an existing portal/SSO
 * session makes the transition immediate; REST/OAuth tokens are not browser
 * login credentials.
 *
 * Set VITE_BITRIX24_URL to a full portal/deep-link URL, or to an empty string
 * to hide the menu item.
 */
export interface Bitrix24MenuConfig {
  url: string;
  label: string;
}

type EnvSource = Record<string, string | undefined>;

const DEFAULT_BITRIX24_URL = 'https://mebelkz.bitrix24.kz/';
const DEFAULT_BITRIX24_LABEL = 'Битрикс24';

/**
 * Resolve Bitrix24 menu config from build-time environment.
 * Returns null when no usable URL is configured (link hidden):
 *  - VITE_BITRIX24_URL explicitly empty, or
 *  - the value is not an http(s) URL.
 *
 * Retired VITE_CRM_* variables are deliberately ignored so an old Twenty
 * deployment override cannot redirect the new Bitrix24 menu item.
 */
export function getBitrix24MenuConfig(
  env: EnvSource = ((import.meta as { env?: EnvSource }).env ?? {}),
): Bitrix24MenuConfig | null {
  const url = (env.VITE_BITRIX24_URL ?? DEFAULT_BITRIX24_URL).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  const label =
    (env.VITE_BITRIX24_LABEL ?? '').trim() || DEFAULT_BITRIX24_LABEL;
  return { url, label };
}

export const bitrix24MenuConfig = getBitrix24MenuConfig();

/** Minimal DOM surface needed to inject resource hints (eases testing). */
type HintDocument = Pick<Document, 'head' | 'createElement' | 'querySelector'>;

/**
 * Inject one-time resource hints so first Bitrix24 open is faster: warm DNS/TLS
 * to portal origin (dns-prefetch + preconnect). Idempotent.
 *
 * NOTE: we intentionally do NOT inject `<link rel="prefetch" as="document">` for
 * the full CRM URL. That document prefetch is a cross-origin fetch governed by
 * the app CSP `default-src 'self'`, so the browser refuses it and logs a CSP
 * violation on every page carrying the Bitrix24 menu. dns-prefetch/preconnect are
 * connection hints (not fetch directives) → they warm the connection without
 * tripping CSP. Top-level navigation is not restricted by connect-src/default-src.
 */
export function ensureBitrix24ResourceHints(
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
    if (doc.querySelector(`link[data-bitrix24-hint="${hint.rel}"]`)) continue;
    const link = doc.createElement('link');
    link.rel = hint.rel;
    link.href = hint.href;
    if (hint.crossOrigin) link.crossOrigin = '';
    if (hint.as) link.setAttribute('as', hint.as);
    link.setAttribute('data-bitrix24-hint', hint.rel);
    doc.head.appendChild(link);
  }
}
