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

/**
 * Why this deployment must not be used for the live check, or null when it talks to stage only.
 * Both addresses must be stated by the runtime configuration: a missing one would make the app
 * fall back to whatever address was built into the bundle, which this check cannot see.
 */
export function stageTargetProblem(runtimeConfig) {
  const api = originOf(runtimeConfig?.apiUrl);
  if (api !== STAGE_API_ORIGIN) return `the deployment's backend is not the stage backend (${api ?? 'no apiUrl'})`;
  const hasura = originOf(runtimeConfig?.hasuraUrl);
  if (hasura !== STAGE_HASURA_ORIGIN) return `the deployment's Hasura is not the stage Hasura (${hasura ?? 'no hasuraUrl'})`;
  return null;
}

/** The one request whose answer the check may rewrite for its own browser: the stage backend's customer screen settings. */
export function isStageSettingsRequest(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  return parsed.origin === STAGE_API_ORIGIN && parsed.pathname === '/api/v1/client-screen/settings';
}

/**
 * The columns one materials table of the customer must have: the ticked ones, in the tab's order,
 * that the manager's own table has. An empty result means the table is not shown at all.
 */
export function expectedMaterialColumns(columns, tickedCodes, managerHeaders) {
  return columns.filter((column) => tickedCodes.includes(column.code) && managerHeaders.includes(column.label)).map((column) => column.label);
}

/** Only calls to the stage backend and the stage Hasura are relayed for a preview build. */
export function isStageRelayTarget(url) {
  return STAGE_ORIGINS.has(originOf(url) ?? '');
}

const DATA_REQUESTS = new Set(['xhr', 'fetch', 'eventsource', 'websocket', 'ping']);

/**
 * A data call of the page that must not leave the browser: anything but the page's own site and
 * the two stage endpoints. Scripts, styles, fonts and images are not data calls.
 */
export function isForbiddenDataRequest(url, resourceType, pageOrigin) {
  if (!DATA_REQUESTS.has(resourceType)) return false;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return true;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
  const origin = parsed.origin.replace(/^ws/, 'http');
  return origin !== pageOrigin && !STAGE_ORIGINS.has(origin);
}

/**
 * Follows this run's own change of the shared setting, so that the cleanup knows what happened
 * even when the run is interrupted while the request is on its way.
 *   none      nothing was sent;
 *   pending   sent, no answer yet;
 *   applied   the server changed the setting for this run (`changed: true`);
 *   noop      the server answered that nothing changed (the values were already there — not ours);
 *   rejected  the server refused (4xx): nothing was written;
 *   unknown   no usable answer (network error, 5xx): the write may or may not have happened.
 */
export function createSettingsChange() {
  let state = 'none';
  let applied = null;
  let inflight = null;
  return {
    /** `send` resolves to { ok, status, body }. The result is returned to the caller as is. */
    run(send) {
      state = 'pending';
      inflight = (async () => {
        try {
          const answer = await send();
          if (answer.ok && answer.body && Number.isSafeInteger(answer.body.version)) {
            applied = answer.body;
            state = answer.body.changed === true ? 'applied' : 'noop';
          } else if (!answer.ok && answer.status >= 400 && answer.status < 500) state = 'rejected';
          else state = 'unknown';
          return answer;
        } catch (error) {
          state = 'unknown';
          throw error;
        }
      })();
      return inflight;
    },
    /** Waits for the answer that is on its way, at most `timeoutMs`. */
    async settle(timeoutMs) {
      if (!inflight) return;
      let timer;
      await Promise.race([
        inflight.catch(() => undefined),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      clearTimeout(timer);
    },
    outcome: () => ({ state, applied }),
  };
}

/**
 * What the cleanup does. Only a change this run provably made is undone, and the request is
 * conditional on the version that change produced: a change made by someone else in the meantime
 * is never overwritten (the server answers 409). When it is not known whether the change was
 * written, nothing is guessed: the setting has to be checked by hand.
 */
export function settingsRestorePlan(original, outcome) {
  const state = outcome?.state ?? 'none';
  if (state === 'none') return { action: 'none', reason: 'this run did not try to change the setting' };
  if (state === 'rejected') return { action: 'none', reason: "the server refused this run's change; nothing was written" };
  if (state === 'noop') return { action: 'none', reason: 'the setting already had these values; they are not this run\'s and stay' };
  if (state === 'applied' && original && outcome.applied?.changed === true && Number.isSafeInteger(outcome.applied.version)) {
    return { action: 'restore', request: { enabled: original.enabled, visibleCodes: original.visibleCodes, expectedVersion: outcome.applied.version } };
  }
  return { action: 'reconcile', reason: "it is not known whether this run's change was written; check the stage setting by hand" };
}
