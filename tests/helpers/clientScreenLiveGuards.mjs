// Guards of the live customer screen check. The check logs in and changes a shared setting, so it
// may run only against the stage backend, and it may restore only what it changed itself.
export const STAGE_SITE = 'https://app-test.mebelkz.app';
export const STAGE_API_ORIGIN = 'https://backend-test.mebelkz.app';
export const STAGE_HASURA_ORIGIN = 'https://hasura-test.mebelkz.app';
const STAGE_ORIGINS = new Set([STAGE_API_ORIGIN, STAGE_HASURA_ORIGIN]);

const originOf = (value) => {
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
};

/** Why this deployment must not be used for the live check, or null when it talks to stage only. */
export function stageTargetProblem(runtimeConfig) {
  const api = originOf(runtimeConfig?.apiUrl);
  if (api !== STAGE_API_ORIGIN) return `the deployment's backend is not the stage backend (${api ?? 'no apiUrl'})`;
  const hasura = runtimeConfig?.hasuraUrl === undefined || runtimeConfig?.hasuraUrl === null || runtimeConfig?.hasuraUrl === ''
    ? STAGE_HASURA_ORIGIN
    : originOf(runtimeConfig.hasuraUrl);
  if (hasura !== STAGE_HASURA_ORIGIN) return `the deployment's Hasura is not the stage Hasura (${hasura ?? 'bad hasuraUrl'})`;
  return null;
}

/** Only calls to the stage backend and the stage Hasura are relayed for a preview build. */
export function isStageRelayTarget(url) {
  return STAGE_ORIGINS.has(originOf(url) ?? '');
}

/**
 * What to write back after the run. `applied` is the server's answer to this run's own change
 * (null when the change was rejected or never made): without it nothing is restored. The restore
 * is conditional on the version this run produced, so a change made by someone else in the
 * meantime is never overwritten — the server answers 409 and the run reports it.
 */
export function settingsRestoreRequest(original, applied) {
  if (!original || !applied || !Number.isSafeInteger(applied.version)) return null;
  return { enabled: original.enabled, visibleCodes: original.visibleCodes, expectedVersion: applied.version };
}
