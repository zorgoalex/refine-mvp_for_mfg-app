/**
 * One Idempotency-Key per user action (users commands, transitional protocol): the same key is reused while the
 * same request is repeated — e.g. after a lost response or a network error, when it is unknown whether the server
 * committed — and a new key is issued for a different request or after a confirmed success. A repeat of a
 * committed request then returns the stored result instead of acting twice.
 */
export interface ActionKeyStore {
  keyFor(request: unknown): string;
  /**
   * The server confirmed the action sent with `key`: the next request is a new action. A late confirmation of an
   * older key does not clear the key of another, still unconfirmed action.
   */
  succeeded(key: string): void;
}

export function createActionKeyStore(newKey: () => string = () => `users-${crypto.randomUUID()}`): ActionKeyStore {
  let pending: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(request) {
      const fingerprint = JSON.stringify(request);
      if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, key: newKey() };
      return pending.key;
    },
    succeeded(key) {
      if (pending?.key === key) pending = null;
    },
  };
}
