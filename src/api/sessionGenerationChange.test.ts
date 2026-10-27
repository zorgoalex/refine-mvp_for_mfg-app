import { describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('./authSession', () => ({ authSession: {
  getSessionGeneration: () => auth.generation,
  subscribe: (listener: () => void) => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); },
} }));

import { subscribeSessionGenerationChange } from './sessionGenerationChange';

const notify = () => auth.listeners.forEach((listener) => listener());

describe('subscribeSessionGenerationChange', () => {
  it('fires on a new session generation only, once per change, until unsubscribed', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeSessionGenerationChange(onChange);
    notify(); // token refresh of the same session
    expect(onChange).not.toHaveBeenCalled();
    auth.generation = 2;
    notify();
    notify();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    auth.generation = 3;
    notify();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
