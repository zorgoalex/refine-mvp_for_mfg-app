import { describe, expect, it, vi } from 'vitest';
import { redirectExpiredAuthSession } from './AuthSessionExpiryBridge';

describe('AuthSessionExpiryBridge', () => {
  it('hard-redirects an expired authenticated page to login', () => {
    const replace = vi.fn();

    redirectExpiredAuthSession({ pathname: '/order-status-board', replace });

    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('does not redirect again when login is already open', () => {
    const replace = vi.fn();

    redirectExpiredAuthSession({ pathname: '/login', replace });

    expect(replace).not.toHaveBeenCalled();
  });
});
