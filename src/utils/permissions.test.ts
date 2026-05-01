import { afterEach, describe, expect, it } from 'vitest';
import { authSession } from '../api/authSession';
import { can, canAll, canAny } from './permissions';

describe('frontend permission helpers', () => {
  afterEach(() => {
    authSession.clear();
  });

  it('checks explicit user permission arrays', () => {
    const user = { permissions: ['orders.view', 'users.view'] };

    expect(can('orders.view', user)).toBe(true);
    expect(can('orders.update', user)).toBe(false);
    expect(canAny(['settings.view', 'users.view'], user)).toBe(true);
    expect(canAll(['orders.view', 'users.view'], user)).toBe(true);
    expect(canAll(['orders.view', 'users.update'], user)).toBe(false);
  });

  it('reads backend authSession by default', () => {
    authSession.setUser({
      id: '1',
      username: 'admin',
      role: 'admin',
      permissions: ['settings.view', 'users.view'],
    });

    expect(can('settings.view')).toBe(true);
    expect(canAny(['users.update', 'users.view'])).toBe(true);
    expect(canAll(['settings.view', 'users.view'])).toBe(true);
  });

  it('fails closed when permissions are absent', () => {
    expect(can('settings.view', null)).toBe(false);
    expect(canAny(['settings.view'], { permissions: undefined })).toBe(false);
    expect(canAll(['settings.view'], { permissions: [] })).toBe(false);
  });
});
