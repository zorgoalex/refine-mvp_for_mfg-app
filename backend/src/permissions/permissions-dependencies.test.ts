import { describe, expect, it } from 'vitest';
import { applyPermissionDependencies } from './permissions.service';

describe('roles matrix dependencies: orders.manager.change', () => {
  it('turning it on turns on orders.update and orders.view', () => {
    const row = { 'orders.manager.change': true, 'orders.update': false, 'orders.view': false };
    applyPermissionDependencies(row);
    expect(row).toEqual({ 'orders.manager.change': true, 'orders.update': true, 'orders.view': true });
  });

  it('removing it together with the order writes in one save keeps all of them removed (rollback closure)', () => {
    const row = {
      'orders.manager.change': false, 'orders.create': false, 'orders.update': false, 'orders.import': false,
      'orders.view': true,
    };
    applyPermissionDependencies(row);
    expect(row).toMatchObject({ 'orders.manager.change': false, 'orders.create': false, 'orders.update': false, 'orders.import': false });
  });
});
