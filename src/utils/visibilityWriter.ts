import type { RoleVisibilityMatrix } from './resourceVisibility';

/**
 * Serializes writes of the screen-visibility setting. The setting is stored as one JSON
 * value and every save replaces it, so each change is built from the result of the
 * previous one (not from a possibly stale snapshot): a role checkbox saved right after a
 * personal override keeps that override.
 */
export interface VisibilityWriter {
  readonly current: RoleVisibilityMatrix;
  readonly pending: number;
  apply(update: (matrix: RoleVisibilityMatrix) => RoleVisibilityMatrix): Promise<RoleVisibilityMatrix>;
  /** Adopt a freshly loaded setting; ignored while writes are pending. */
  sync(saved: RoleVisibilityMatrix): boolean;
}

export function createVisibilityWriter(
  initial: RoleVisibilityMatrix,
  save: (next: RoleVisibilityMatrix) => Promise<void>,
): VisibilityWriter {
  let current = initial;
  let pending = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    get current() {
      return current;
    },
    get pending() {
      return pending;
    },
    apply(update) {
      pending += 1;
      const run = chain.then(async () => {
        try {
          const next = update(current);
          await save(next);
          current = next;
          return next;
        } finally {
          // Before the caller resumes: it reads `pending` right after awaiting.
          pending -= 1;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    sync(saved) {
      if (pending > 0) return false;
      current = saved;
      return true;
    },
  };
}
