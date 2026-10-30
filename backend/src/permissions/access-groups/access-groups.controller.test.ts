import { describe, expect, it, vi } from 'vitest';
import { parseIdempotencyKey } from '../authorization-idempotency';
import type { CurrentUser } from '../current-user';
import { PermissionsService } from '../permissions.service';
import { AccessGroupsController, UserAccessGroupsController } from './access-groups.controller';
import { normalizeScopes, type PgAccessGroupsRepository } from './pg-access-groups.repository';

const permissions = new PermissionsService({ isConfigured: false } as never);
const user = (rights: string[]): CurrentUser => ({ id: '7', username: 'u7', role: 'superadmin', roleId: 2, permissions: rights } as CurrentUser);
const ADMIN = ['system.superadmin', 'permissions.manage'];

function repository() {
  return {
    list: vi.fn(async () => ({ enabled: false, permissionsVersion: 1, groups: [] })),
    create: vi.fn(async () => ({ groupId: 1 })),
    replacePermissions: vi.fn(async () => ({ groupId: 1 })),
    userAuthorization: vi.fn(async () => ({ userId: 3 })),
    replaceUserGroups: vi.fn(async () => ({ userId: 3 })),
  } as unknown as PgAccessGroupsRepository & Record<string, ReturnType<typeof vi.fn>>;
}

describe('AccessGroupsController', () => {
  it('reads with permissions.manage or system.superadmin; nothing else', async () => {
    const groups = repository();
    const controller = new AccessGroupsController(groups, permissions);
    await expect(controller.list({ user: user(['permissions.manage']) } as never)).resolves.toMatchObject({ enabled: false });
    await expect(controller.list({ user: user(['system.superadmin']) } as never)).resolves.toMatchObject({ enabled: false });
    await expect(controller.list({ user: user(['users.manage']) } as never)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    await expect(controller.list({} as never)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('changes need both rights and an Idempotency-Key, and pass the key to the command', async () => {
    const groups = repository();
    const controller = new AccessGroupsController(groups, permissions);
    const body = { code: 'managers', name: 'Менеджеры' };
    await expect(controller.create({ user: user(['permissions.manage']) } as never, body, 'key-12345678'))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(controller.create({ user: user(ADMIN) } as never, body, undefined))
      .rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    await expect(controller.create({ user: user(ADMIN) } as never, body, ['key-12345678', 'key-87654321']))
      .rejects.toMatchObject({ statusCode: 422 });
    await controller.create({ user: user(ADMIN), requestId: 'r1' } as never, body, 'key-12345678');
    expect(groups.create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'key-12345678', requestId: 'r1' }), body);
  });

  it('validates bodies strictly (unknown fields, bad code, too many scope values)', async () => {
    const controller = new AccessGroupsController(repository(), permissions);
    const request = { user: user(ADMIN) } as never;
    await expect(controller.create(request, { code: 'Bad Code', name: 'x' }, 'key-12345678')).rejects.toMatchObject({ statusCode: 422 });
    await expect(controller.create(request, { code: 'ok_code', name: 'x', extra: 1 }, 'key-12345678')).rejects.toMatchObject({ statusCode: 422 });
    await expect(controller.permissionsOf(request, '1', { version: 1, permissions: [], scopes: { 'orders.view': ['all', 'own', 'assigned', 'x'] } }, 'key-12345678'))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(controller.permissionsOf(request, '0', { version: 1, permissions: [], scopes: {} }, 'key-12345678')).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('UserAccessGroupsController', () => {
  it('reads the sources with the reader rights and changes groups with both', async () => {
    const groups = repository();
    const controller = new UserAccessGroupsController(groups, permissions);
    await expect(controller.authorization({ user: user(['permissions.manage']) } as never, '3')).resolves.toEqual({ userId: 3 });
    await expect(controller.replace({ user: user(['permissions.manage']) } as never, '3', { rowVersion: 1, groupIds: [] }, 'key-12345678'))
      .rejects.toMatchObject({ statusCode: 403 });
    await controller.replace({ user: user(ADMIN) } as never, '3', { rowVersion: 1, groupIds: [2] }, 'key-12345678');
    expect(groups.replaceUserGroups).toHaveBeenCalledWith(expect.anything(), 3, { rowVersion: 1, groupIds: [2] });
  });
});

describe('normalizeScopes', () => {
  it('keeps a set per key, sorted and without duplicates; drops empty keys', () => {
    expect(normalizeScopes({ 'orders.view': ['own', 'assigned', 'own'], 'orders.edit': [] })).toEqual({ 'orders.view': ['assigned', 'own'] });
  });

  it('refuses none, unknown values and unknown keys', () => {
    expect(() => normalizeScopes({ 'orders.view': ['none'] })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE_VALUE' }));
    expect(() => normalizeScopes({ 'orders.view': ['everything'] })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE_VALUE' }));
    expect(() => normalizeScopes({ 'no.such.scope': ['all'] })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE_VALUE' }));
  });
});

describe('parseIdempotencyKey', () => {
  it('is optional only where asked, and always well-formed when given', () => {
    expect(parseIdempotencyKey(undefined, false)).toBeUndefined();
    expect(() => parseIdempotencyKey(undefined, true)).toThrow(expect.objectContaining({ statusCode: 422 }));
    expect(() => parseIdempotencyKey('short', false)).toThrow(expect.objectContaining({ statusCode: 422 }));
    expect(() => parseIdempotencyKey('has space 123', false)).toThrow(expect.objectContaining({ statusCode: 422 }));
    expect(parseIdempotencyKey(['matrix-key-1'], false)).toBe('matrix-key-1');
  });
});
