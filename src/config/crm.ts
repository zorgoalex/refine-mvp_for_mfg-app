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
