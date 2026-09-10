import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service';
import { parseItem, parseList, requireCatalogPermission } from './catalog.validation';
import type { CurrentUser } from '../../permissions/current-user';
import type { DatabaseService } from '../../database/database.service';

const actor: CurrentUser = { id: '1', username: 'test', role: 'admin', roleId: 1, permissions: ['references.manage'] };
const item = { name: ' Доставка ', sku: ' SKU ', kind: 'service', unitId: 1, basePrice: '12.5', description: '', isActive: true };

describe('catalog validation and permissions', () => {
  it('normalizes fields and decimal strings without floating arithmetic', () => {
    expect(parseItem(item)).toMatchObject({ name: 'Доставка', sku: 'SKU', basePrice: '12.50' });
    expect(parseItem({ ...item, sku: ' ', basePrice: null })).toMatchObject({ sku: null, basePrice: null });
    expect(parseItem({ ...item, basePrice: '0' }).basePrice).toBe('0.00');
    expect(parseItem({ ...item, basePrice: '9999999999.99' }).basePrice).toBe('9999999999.99');
  });
  it.each(['-1', '1e2', '0.001', 'NaN', '10000000000', '', 12])('rejects invalid price %s', basePrice => {
    expect(() => parseItem({ ...item, basePrice })).toThrow();
  });
  it('rejects invalid types, unit IDs, unknown fields and missing optimistic version', () => {
    for (const patch of [{ kind: 'fake' }, { unitId: 0 }, { unitId: 1.5 }, { name: ' ' }, { currency: 'USD' }]) {
      expect(() => parseItem({ ...item, ...patch })).toThrow();
    }
    expect(() => parseItem(item, true)).toThrow();
    expect(parseItem({ ...item, expectedVersion: 2 }, true)).toMatchObject({ expectedVersion: 2 });
  });
  it('bounds pagination and rejects unknown query fields', () => {
    expect(parseList({})).toMatchObject({ limit: 25, offset: 0, active: 'true' });
    expect(parseList({ q: '%_', active: 'all', limit: '100' })).toMatchObject({ q: '%_', active: 'all', limit: 100 });
    for (const query of [{ limit: '101' }, { offset: '-1' }, { offset: '1e2' }, { arbitrary: 'x' }]) expect(() => parseList(query)).toThrow();
  });
  it('uses literal permissions, never admin role bypass', async () => {
    expect(() => requireCatalogPermission(undefined)).toThrow('Требуется вход');
    expect(() => requireCatalogPermission({ ...actor, permissions: [] })).toThrow('Недостаточно прав');
    expect(() => requireCatalogPermission({ ...actor, permissions: ['references.view'] }, true)).toThrow('Недостаточно прав');
    expect(requireCatalogPermission(actor)).toBe(actor);
    const transaction = vi.fn();
    const service = new CatalogService({ transaction } as unknown as DatabaseService);
    await expect(service.save({ ...actor, permissions: [] }, item, 'catalog-key', 'req')).rejects.toMatchObject({ statusCode: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
