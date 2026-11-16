import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { PermissionCatalogDto } from '../../api/types/permissionsMatrixApi.types';
import {
  accessGroupsErrorText,
  addedDangerous,
  createCommandLock,
  createRequestGenerations,
  createSaveReloadCoordinator,
  draftsAfterConflict,
  draftsAfterSave,
  readLatest,
  groupScopeValues,
  isStaleConflict,
  memberHasuraWarnings,
  normalizeGroupScopes,
  permissionsByDomain,
  sameScopes,
  sourceLabel,
  userGroupsAfterReload,
} from './accessGroupsModel';

const permission = (name: string, domain: string, extra: Partial<PermissionCatalogDto> = {}): PermissionCatalogDto =>
  ({ name, domain, label: name, description: null, sortOrder: 0, isDangerous: false, isActive: true, ...extra }) as PermissionCatalogDto;
const apiError = (code: string, details?: unknown) => new ApiError({ code, message: `backend ${code}`, status: 409, details });

describe('access groups model', () => {
  it('groups active catalog permissions by domain in catalog order, with search and «only selected»', () => {
    const catalog = [
      permission('orders.view', 'orders', { sortOrder: 2 }),
      permission('clients.view', 'clients', { sortOrder: 1 }),
      permission('orders.manager.change', 'orders', { sortOrder: 3, label: 'Смена менеджера' }),
      permission('old.right', 'orders', { sortOrder: 4, isActive: false }),
    ];
    expect(permissionsByDomain(catalog).map((group) => [group.domain, group.permissions.map((item) => item.name)])).toEqual([
      ['clients', ['clients.view']],
      ['orders', ['orders.view', 'orders.manager.change']],
    ]);
    expect(permissionsByDomain(catalog, 'менеджер')[0].permissions.map((item) => item.name)).toEqual(['orders.manager.change']);
    expect(permissionsByDomain(catalog, '', new Set(['clients.view'])).map((group) => group.domain)).toEqual(['clients']);
  });

  it('compares scope sets as the server stores them; groups never grant none', () => {
    expect(normalizeGroupScopes({ 'orders.view': ['own', 'assigned', 'own'], 'payments.view': [] })).toEqual({ 'orders.view': ['assigned', 'own'] });
    expect(sameScopes({ 'orders.view': ['own', 'assigned'], x: [] }, { 'orders.view': ['assigned', 'own'] })).toBe(true);
    expect(sameScopes({ 'orders.view': ['own'] }, { 'orders.view': ['all'] })).toBe(false);
    expect(groupScopeValues({ key: 'orders.view', label: '', allowedValues: ['all', 'own', 'assigned', 'none'] })).toEqual(['all', 'own', 'assigned']);
  });

  it('asks to confirm only the dangerous permissions the draft adds', () => {
    const catalog = [permission('system.superadmin', 'system', { isDangerous: true }), permission('users.manage', 'users', { isDangerous: true }), permission('clients.view', 'clients')];
    expect(addedDangerous(catalog, ['users.manage'], ['users.manage', 'system.superadmin', 'clients.view'])).toEqual(['system.superadmin']);
  });

  it('warns about members whose base Hasura role cannot use a group permission', () => {
    const members = [
      { userId: 1, username: 'viewer', roleCode: 'viewer' },
      { userId: 2, username: 'manager', roleCode: 'manager' },
    ];
    expect(memberHasuraWarnings(['clients.create', 'orders.manager.change'], members)).toEqual([
      { userId: 1, username: 'viewer', roleCode: 'viewer', gaps: [{ permission: 'clients.create', targets: ['clients.insert'] }] },
    ]);
  });

  it('explains refusals and marks the «changed meanwhile» ones', () => {
    expect(isStaleConflict(apiError('ACCESS_GROUP_VERSION_CONFLICT'))).toBe(true);
    expect(isStaleConflict(apiError('PERMISSIONS_LOCKOUT_DENIED'))).toBe(false);
    expect(accessGroupsErrorText(apiError('PERMISSIONS_LOCKOUT_DENIED', { byRole: true }))).toContain('администратор по роли');
    expect(accessGroupsErrorText(apiError('PERMISSIONS_LOCKOUT_DENIED'))).toContain('без активного администратора');
    expect(accessGroupsErrorText(apiError('PERMISSION_NARROWING_BLOCKED'))).toBe('backend PERMISSION_NARROWING_BLOCKED');
    expect(accessGroupsErrorText(new Error(''), 'запасной текст')).toBe('запасной текст');
  });

  it('names the source of a grant', () => {
    const names = new Map([['manager_change', 'Смена менеджера']]);
    expect(sourceLabel('role', names)).toBe('роль');
    expect(sourceLabel('group:manager_change', names)).toBe('Смена менеджера');
    expect(sourceLabel('group:gone', names)).toBe('gone');
  });
});

describe('group card drafts after a save (review R1: one section must not discard another)', () => {
  const saved = {
    name: 'Сервер', description: null, permissions: ['orders.view'], scopes: { 'orders.view': ['own'] },
    members: [{ userId: 1, username: 'a', roleCode: 'manager', isActive: true }, { userId: 2, username: 'b', roleCode: 'viewer', isActive: true }],
  };
  const drafts = { name: 'Черновик', description: 'текст', permissions: ['orders.view', 'clients.view'], scopes: { 'orders.view': ['all'] }, memberIds: [1] };

  it('saving permissions keeps an unsaved member removal and an unsaved name', () => {
    expect(draftsAfterSave('permissions', saved, drafts)).toEqual({ ...drafts, permissions: ['orders.view'], scopes: { 'orders.view': ['own'] } });
  });

  it('saving members keeps unsaved permissions; the activity switch keeps everything', () => {
    expect(draftsAfterSave('members', saved, drafts)).toEqual({ ...drafts, memberIds: [1, 2] });
    expect(draftsAfterSave('active', saved, drafts)).toEqual(drafts);
    expect(draftsAfterSave('meta', saved, drafts)).toEqual({ ...drafts, name: 'Сервер', description: '' });
    expect(draftsAfterSave('all', saved, drafts).memberIds).toEqual([1, 2]);
  });
});

describe('user card groups after a reload (review R1: role saved → rights read again)', () => {
  it('keeps an unsaved choice, otherwise shows the server state', () => {
    expect(userGroupsAfterReload([1, 3], [1], [1])).toEqual({ groups: [1, 3], discarded: false });
    expect(userGroupsAfterReload([1], [1], [1, 2])).toEqual({ groups: [1, 2], discarded: false });
    expect(userGroupsAfterReload([], null, [4])).toEqual({ groups: [4], discarded: false });
  });
});

describe('R2: conflicts and late answers', () => {
  it('a read sent before a save cannot apply after it', () => {
    const generations = createRequestGenerations();
    const earlyRead = generations.begin();
    generations.begin(); // the save
    expect(generations.isCurrent(earlyRead)).toBe(false);
    const laterRead = generations.begin();
    expect(generations.isCurrent(laterRead)).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('R3: response order with delayed answers', () => {
  it('a refresh that answers after the switch command does not show the old switch state', async () => {
    const generations = createRequestGenerations();
    const shown: string[] = [];
    const slowRefresh = deferred<string>();
    const refresh = readLatest(generations, () => slowRefresh.promise, (value) => shown.push(value));
    // the switch command: invalidates earlier reads, applies its own answer
    generations.begin();
    shown.push('enabled (command answer)');
    slowRefresh.resolve('disabled (old read)');
    expect(await refresh).toBe(false);
    expect(shown).toEqual(['enabled (command answer)']);
  });

  it('two overlapping commands: the second does not start, the conflict reload stays inside the lock', async () => {
    const lock = createCommandLock();
    const events: string[] = [];
    const firstAnswer = deferred<void>();
    const reloadAnswer = deferred<void>();
    const first = lock.run(async () => {
      events.push('command 1 sent');
      await firstAnswer.promise.catch(() => undefined);
      events.push('conflict → reload');
      await reloadAnswer.promise;
      events.push('reload applied');
    });
    const second = await lock.run(async () => {
      events.push('command 2 sent');
    });
    expect(second).toBeUndefined();
    expect(lock.busy).toBe(true);
    firstAnswer.reject(new Error('409'));
    await Promise.resolve();
    expect(lock.busy).toBe(true);
    reloadAnswer.resolve();
    await first;
    expect(lock.busy).toBe(false);
    expect(events).toEqual(['command 1 sent', 'conflict → reload', 'reload applied']);
    await lock.run(async () => {
      events.push('command 3 sent');
    });
    expect(events.at(-1)).toBe('command 3 sent');
  });

  it('of two reloads the earlier answer arriving last is dropped; its error is silent', async () => {
    const generations = createRequestGenerations();
    const applied: number[] = [];
    const errors: unknown[] = [];
    const early = deferred<number>();
    const late = deferred<number>();
    const first = readLatest(generations, () => early.promise, (value) => applied.push(value), (error) => errors.push(error));
    const second = readLatest(generations, () => late.promise, (value) => applied.push(value), (error) => errors.push(error));
    late.resolve(3);
    expect(await second).toBe(true);
    early.reject(new Error('old'));
    expect(await first).toBe(false);
    expect(applied).toEqual([3]);
    expect(errors).toEqual([]);
  });
});

describe('R4: first load of a user who already has groups', () => {
  it('the empty initial selection is not an unsaved edit (no baseline yet)', () => {
    expect(userGroupsAfterReload([], null, [4]).groups).toEqual([4]);
    // the second load with the first baseline: nothing changed by hand → the server's groups
    expect(userGroupsAfterReload([4], [4], [4, 5]).groups).toEqual([4, 5]);
  });
});

describe('R5: drafts after a conflict — three-way per section', () => {
  const member = (userId: number) => ({ userId, username: `u${userId}`, roleCode: 'viewer', isActive: true });
  const base = { name: 'Группа', description: null, permissions: ['orders.view'], scopes: {}, members: [member(1), member(2)] };

  it('name conflict, members removed elsewhere, then a member added here: the removed one is not resent', () => {
    const drafts = { name: 'Новое имя', description: '', permissions: ['orders.view'], scopes: {}, memberIds: [1, 2] };
    const latest = { ...base, name: 'Имя от B', members: [member(1)] };
    const merged = draftsAfterConflict(base, latest, drafts);
    expect(merged.drafts.memberIds).toEqual([1]); // untouched here → the server's (U=2 removed stays removed)
    expect(merged.discarded).toEqual(['meta']); // both renamed → the local name is dropped and named
    expect(merged.drafts.name).toBe('Имя от B');
    const later = { ...merged.drafts, memberIds: [...merged.drafts.memberIds, 3] };
    expect(later.memberIds).toEqual([1, 3]);
  });

  it('own edit of an unchanged section stays; untouched sections follow the server', () => {
    const drafts = { name: 'Группа', description: '', permissions: ['orders.view', 'clients.view'], scopes: {}, memberIds: [1, 2] };
    const latest = { ...base, description: 'от B', members: [member(1), member(2), member(4)] };
    const merged = draftsAfterConflict(base, latest, drafts);
    expect(merged.discarded).toEqual([]);
    expect(merged.drafts.permissions).toEqual(['orders.view', 'clients.view']);
    expect(merged.drafts.memberIds).toEqual([1, 2, 4]);
    expect(merged.drafts.description).toBe('от B');
  });

  it('own member edit clashing with a member change elsewhere is dropped', () => {
    const drafts = { name: 'Группа', description: '', permissions: ['orders.view'], scopes: {}, memberIds: [1, 2, 5] };
    const latest = { ...base, members: [member(2)] };
    const merged = draftsAfterConflict(base, latest, drafts);
    expect(merged.discarded).toEqual(['members']);
    expect(merged.drafts.memberIds).toEqual([2]);
  });
});

describe('R6: the user choice and the version it is checked with stay together', () => {
  it('external removal, then a local addition on the old memberships: the choice is dropped, not resent', () => {
    // read: groups [A=1]; elsewhere A removed → server []; locally B=2 added → [1, 2]
    expect(userGroupsAfterReload([1, 2], [1], [])).toEqual({ groups: [], discarded: true });
  });

  it('a local change on unchanged memberships survives a reload (e.g. after the role was saved)', () => {
    expect(userGroupsAfterReload([1, 2], [1], [1])).toEqual({ groups: [1, 2], discarded: false });
  });
});

describe('R7: a reload asked for during a save runs after it (deferred answers)', () => {
  it('a delayed role save asks to reload while the group save runs: the read starts only after the save answered', async () => {
    const coordinator = createSaveReloadCoordinator();
    const events: string[] = [];
    const saveAnswer = deferred<string>();
    const saving = coordinator.save(async () => {
      events.push('group save sent');
      const answer = await saveAnswer.promise;
      events.push(`applied ${answer}`);
    });
    coordinator.reload(() => events.push('reload A sent'));
    coordinator.reload(() => events.push('reload B sent'));
    expect(events).toEqual(['group save sent']);
    saveAnswer.resolve('v3');
    await saving;
    // one reload, after the confirmed answer: it reads v3, it cannot bring back v2
    expect(events).toEqual(['group save sent', 'applied v3', 'reload B sent']);
    coordinator.reload(() => events.push('reload C sent'));
    expect(events.at(-1)).toBe('reload C sent');
  });

  it('a second save while one runs is not sent', async () => {
    const coordinator = createSaveReloadCoordinator();
    const first = deferred<void>();
    const running = coordinator.save(() => first.promise);
    expect(await coordinator.save(async () => 'second')).toBeUndefined();
    first.resolve();
    await running;
    expect(await coordinator.save(async () => 'third')).toBe('third');
  });
});
