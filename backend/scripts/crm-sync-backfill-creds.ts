/**
 * Pure credential resolution for the CRM-sync backfill entrypoint.
 *
 * Trims TWENTY_SYNC_BASE_URL / TWENTY_SYNC_API_KEY and treats blank
 * (missing or whitespace-only) values as absent so a config typo
 * hard-refuses (fail-closed) instead of constructing a live client with
 * an empty bearer token that would only 401-churn against Twenty.
 *
 * Never logs or returns secret values to the caller's stderr/stdout.
 */
export interface TwentyCreds {
  baseUrl: string;
  apiKey: string;
}

export function resolveTwentyCreds(env: NodeJS.ProcessEnv): TwentyCreds | null {
  const baseUrl = (env.TWENTY_SYNC_BASE_URL ?? '').trim();
  const apiKey = (env.TWENTY_SYNC_API_KEY ?? '').trim();

  if (!baseUrl || !apiKey) {
    return null;
  }

  return { baseUrl, apiKey };
}
