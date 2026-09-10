import { describe, expect, it, vi } from 'vitest';
import { CatalogController } from './catalog.controller';
import type { CatalogService } from './catalog.service';
import type { CurrentUser } from '../../permissions/current-user';

describe('catalog HTTP boundary', () => {
  const user: CurrentUser = { id: '1', username: 'test', role: 'admin', roleId: 1, permissions: ['references.view'] };
  it('blocks unauthenticated read and read-only writes before calling service', () => {
    const service = { save: vi.fn(), list: vi.fn(), units: vi.fn(), get: vi.fn() };
    const controller = new CatalogController(service as unknown as CatalogService);
    expect(() => controller.list({}, {})).toThrow('Требуется вход');
    expect(() => controller.create({ user }, {}, 'key-test')).toThrow('Недостаточно прав');
    expect(() => controller.update({ user }, '1', {}, 'key-test')).toThrow('Недостаточно прав');
    expect(service.save).not.toHaveBeenCalled();
    controller.units({ user });
    expect(service.units).toHaveBeenCalledWith(user);
  });
  it('does not route invalid IDs to database', () => {
    const get = vi.fn();
    const controller = new CatalogController({ get } as unknown as CatalogService);
    for (const id of ['-1', '1.2', '1e3', '9007199254740992']) expect(() => controller.get({ user }, id)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
