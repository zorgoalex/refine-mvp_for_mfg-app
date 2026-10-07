import { describe, expect, it } from 'vitest';
import { createActionKeyStore } from './actionIdempotency';

describe('one Idempotency-Key per user action', () => {
  it('repeats the key for the same request until success; a different request or a new action gets a new one', () => {
    let n = 0;
    const store = createActionKeyStore(() => `k-${++n}`);
    const save = { fullName: 'X', expectedVersion: 4 };

    expect(store.keyFor(save)).toBe('k-1');
    // Network error / lost response: the user presses «Save» again with the same data — same key, a replay.
    expect(store.keyFor({ ...save })).toBe('k-1');
    // Changed data: a different action.
    expect(store.keyFor({ ...save, fullName: 'Y' })).toBe('k-2');
    store.succeeded('k-2');
    expect(store.keyFor({ ...save, fullName: 'Y' })).toBe('k-3');
  });
});
