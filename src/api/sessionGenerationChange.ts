import { authSession } from './authSession';

/** Calls `onChange` once per change of the auth session generation (re-login, user switch, permission/scope change) —
 * not on token refreshes of the same session. Returns the unsubscribe function. */
export function subscribeSessionGenerationChange(onChange: () => void): () => void {
  let generation = authSession.getSessionGeneration();
  return authSession.subscribe(() => {
    const next = authSession.getSessionGeneration();
    if (next === generation) return;
    generation = next;
    onChange();
  });
}
