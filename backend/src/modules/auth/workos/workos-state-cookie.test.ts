import { describe, expect, it, vi } from 'vitest';
import { createWorkosState, verifyWorkosState } from './workos-state-cookie';

const SECRET = 'unit-secret';

describe('workos state cookie', () => {
  it('round-trips a signed login state', () => {
    const { state, cookieValue } = createWorkosState(SECRET, 'login');
    const payload = verifyWorkosState(SECRET, cookieValue);

    expect(payload).not.toBeNull();
    expect(payload?.state).toBe(state);
    expect(payload?.mode).toBe('login');
    expect(payload?.sessionId).toBeUndefined();
  });

  it('binds link mode to a session id', () => {
    const { cookieValue } = createWorkosState(SECRET, 'link', 'session-7');
    const payload = verifyWorkosState(SECRET, cookieValue);

    expect(payload?.mode).toBe('link');
    expect(payload?.sessionId).toBe('session-7');
  });

  it('rejects tampered payloads and wrong secrets', () => {
    const { cookieValue } = createWorkosState(SECRET, 'link', 'session-7');
    const [encoded, signature] = [
      cookieValue.slice(0, cookieValue.lastIndexOf('.')),
      cookieValue.slice(cookieValue.lastIndexOf('.') + 1),
    ];
    const tamperedPayload = Buffer.from(
      JSON.stringify({ state: 'x', mode: 'link', sessionId: 'attacker', expiresAt: Date.now() + 60000 }),
    ).toString('base64url');

    expect(verifyWorkosState(SECRET, `${tamperedPayload}.${signature}`)).toBeNull();
    expect(verifyWorkosState('other-secret', `${encoded}.${signature}`)).toBeNull();
    expect(verifyWorkosState(SECRET, undefined)).toBeNull();
    expect(verifyWorkosState(SECRET, 'garbage')).toBeNull();
  });

  it('rejects expired state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T10:00:00Z'));
    const { cookieValue } = createWorkosState(SECRET, 'login');
    vi.setSystemTime(new Date('2026-07-03T10:11:00Z'));

    expect(verifyWorkosState(SECRET, cookieValue)).toBeNull();
    vi.useRealTimers();
  });
});
