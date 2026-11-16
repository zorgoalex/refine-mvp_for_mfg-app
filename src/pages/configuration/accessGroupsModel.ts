import { ApiError } from '../../api/apiError';
import type { AccessGroupDto, AccessGroupMemberDto, AccessGroupScopes } from '../../api/types/accessGroupsApi.types';
import type { PermissionCatalogDto, ScopeKeyDto } from '../../api/types/permissionsMatrixApi.types';
import { hasuraReachGaps, type HasuraReachGap } from '../../utils/hasuraPermissionReach';

/** Answers that mean «someone changed it meanwhile»: reload, then repeat. */
const STALE_CODES = new Set(['ACCESS_GROUP_VERSION_CONFLICT', 'USER_VERSION_CONFLICT', 'PERMISSIONS_VERSION_CONFLICT']);

export function isStaleConflict(error: unknown): boolean {
  return error instanceof ApiError && STALE_CODES.has(String(error.code));
}

/** Text of an access-groups (or roles-matrix) refusal for the user. */
export function accessGroupsErrorText(error: unknown, fallback = 'Не удалось сохранить'): string {
  if (!(error instanceof ApiError)) return error instanceof Error && error.message ? error.message : fallback;
  switch (error.code) {
    case 'ACCESS_GROUP_VERSION_CONFLICT':
      return 'Группу изменили в другой сессии. Обновите данные и повторите.';
    case 'USER_VERSION_CONFLICT':
      return 'Пользователя изменили в другой сессии. Обновите страницу и повторите.';
    case 'PERMISSIONS_VERSION_CONFLICT':
      return 'Права изменились в другой сессии. Обновите данные и повторите.';
    case 'PERMISSIONS_LOCKOUT_DENIED':
      return isRecord(error.details) && error.details.byRole === true
        ? 'Пока группы доступа включены, должен остаться активный администратор по роли (без групп).'
        : 'Нельзя оставить систему без активного администратора.';
    case 'AUTHORIZATION_CHANGES_PAUSED':
      return 'Сейчас идёт откат настройки Hasura — изменения прав временно запрещены.';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'Предыдущий запрос ещё выполняется. Повторите через несколько секунд.';
    case 'PERMISSION_DENIED':
      return 'Недостаточно прав: нужны «Управление правами» и «Суперадминистратор».';
    default:
      return error.message || fallback;
  }
}

export interface PermissionDomainGroup {
  domain: string;
  permissions: PermissionCatalogDto[];
}

/** Active catalog permissions by domain, in catalog order; `search` matches name, label or domain. */
export function permissionsByDomain(catalog: readonly PermissionCatalogDto[], search = '', onlyNames?: ReadonlySet<string>): PermissionDomainGroup[] {
  const needle = search.trim().toLowerCase();
  const groups = new Map<string, PermissionCatalogDto[]>();
  for (const permission of [...catalog].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!permission.isActive) continue;
    if (onlyNames && !onlyNames.has(permission.name)) continue;
    if (needle && ![permission.name, permission.label, permission.domain].some((text) => text.toLowerCase().includes(needle))) continue;
    if (!groups.has(permission.domain)) groups.set(permission.domain, []);
    groups.get(permission.domain)!.push(permission);
  }
  return [...groups].map(([domain, permissions]) => ({ domain, permissions }));
}

/** Scope values a group may grant: the allowed values of the key without 'none'. */
export function groupScopeValues(scopeKey: ScopeKeyDto): string[] {
  return scopeKey.allowedValues.filter((value) => value !== 'none');
}

/** Drops empty keys and sorts values: the shape the server stores (compare drafts with it). */
export function normalizeGroupScopes(scopes: AccessGroupScopes): AccessGroupScopes {
  const result: AccessGroupScopes = {};
  for (const [key, values] of Object.entries(scopes)) {
    const unique = [...new Set(values)].sort();
    if (unique.length > 0) result[key] = unique;
  }
  return result;
}

export function sameScopes(a: AccessGroupScopes, b: AccessGroupScopes): boolean {
  return JSON.stringify(sortedEntries(normalizeGroupScopes(a))) === JSON.stringify(sortedEntries(normalizeGroupScopes(b)));
}

export function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Dangerous permissions the draft adds to the group: they need an explicit confirmation (as in the roles matrix). */
export function addedDangerous(catalog: readonly PermissionCatalogDto[], before: readonly string[], after: readonly string[]): string[] {
  const dangerous = new Set(catalog.filter((permission) => permission.isDangerous).map((permission) => permission.name));
  const had = new Set(before);
  return after.filter((name) => dangerous.has(name) && !had.has(name));
}

export interface MemberHasuraWarning {
  userId: number;
  username: string;
  roleCode: string | null;
  gaps: HasuraReachGap[];
}

/**
 * Members whose base role cannot use some of the group's permissions in Hasura (plan v6 §6): a group never adds Hasura
 * permissions, the base role's profile stays. Backend-only permissions give no warning.
 */
export function memberHasuraWarnings(
  permissions: readonly string[],
  members: ReadonlyArray<Pick<AccessGroupMemberDto, 'userId' | 'username' | 'roleCode'> & { held?: readonly string[] }>,
): MemberHasuraWarning[] {
  return members
    .map((member) => ({
      userId: member.userId,
      username: member.username,
      roleCode: member.roleCode,
      gaps: hasuraReachGaps(permissions, member.roleCode, new Set(member.held ?? [])),
    }))
    .filter((warning) => warning.gaps.length > 0);
}

/** A readable source of an effective grant: 'role' → «роль», 'group:<code>' → the group name (or its code). */
export function sourceLabel(source: string, groupNames: ReadonlyMap<string, string>): string {
  if (source === 'role') return 'роль';
  const code = source.startsWith('group:') ? source.slice('group:'.length) : source;
  return groupNames.get(code) ?? code;
}

export const ACCESS_GROUP_CODE_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

function sortedEntries(scopes: AccessGroupScopes) {
  return Object.entries(scopes).sort(([a], [b]) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface GroupDrafts {
  name: string;
  description: string;
  permissions: string[];
  scopes: AccessGroupScopes;
  memberIds: number[];
}

/** The sections of a group card saved by separate commands; 'active' (the switch) sends only the activity. */
export type GroupSection = 'all' | 'meta' | 'active' | 'permissions' | 'members';

/**
 * Drafts after a confirmed save of `section`: the saved section takes the server's state, every other section keeps
 * its unsaved edits (each command returns the whole group, but changed only its own part).
 */
export function draftsAfterSave(section: GroupSection, saved: Pick<AccessGroupDto, 'name' | 'description' | 'permissions' | 'scopes' | 'members'>, drafts: GroupDrafts): GroupDrafts {
  const fromServer: GroupDrafts = {
    name: saved.name,
    description: saved.description ?? '',
    permissions: [...saved.permissions],
    scopes: { ...saved.scopes },
    memberIds: saved.members.map((member) => member.userId),
  };
  if (section === 'all') return fromServer;
  return {
    name: section === 'meta' ? fromServer.name : drafts.name,
    description: section === 'meta' ? fromServer.description : drafts.description,
    permissions: section === 'permissions' ? fromServer.permissions : drafts.permissions,
    scopes: section === 'permissions' ? fromServer.scopes : drafts.scopes,
    memberIds: section === 'members' ? fromServer.memberIds : drafts.memberIds,
  };
}

/**
 * Groups of a user after the card reads them again (e.g. after the user's role was saved, or a conflict). Three-way
 * against the groups the choice was made from (`previousSaved`): no own change → the server's groups; an own change
 * and the server's groups unchanged → the choice stays (it is still based on the current server state); an own change
 * and the server's groups changed too → the choice is dropped (`discarded`), the server's groups are shown.
 */
export function userGroupsAfterReload(
  current: readonly number[],
  previousSaved: readonly number[] | null,
  saved: readonly number[],
): { groups: number[]; discarded: boolean } {
  const editedHere = previousSaved !== null && !sameSet(current, previousSaved);
  if (!editedHere) return { groups: [...saved], discarded: false };
  if (sameSet(previousSaved!, saved)) return { groups: [...current], discarded: false };
  return { groups: [...saved], discarded: true };
}

/**
 * Generations of reads of one card: a command starts a new generation, so a read sent before it cannot overwrite the
 * command's confirmed answer when it arrives late.
 */
export function createRequestGenerations() {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    },
  };
}

/**
 * One command at a time (per group card / per switch): a second start while one runs is ignored, and everything the
 * command awaits — including its conflict recovery read — stays inside the lock.
 */
export function createCommandLock() {
  let running = false;
  return {
    get busy(): boolean {
      return running;
    },
    async run<T>(command: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined;
      running = true;
      try {
        return await command();
      } finally {
        running = false;
      }
    },
  };
}

/**
 * A read that applies its answer only if no newer read or command started meanwhile (createRequestGenerations).
 * Returns whether it applied.
 */
export async function readLatest<T>(
  generations: ReturnType<typeof createRequestGenerations>,
  read: () => Promise<T>,
  applyAnswer: (value: T) => void,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  const generation = generations.begin();
  try {
    const value = await read();
    if (!generations.isCurrent(generation)) return false;
    applyAnswer(value);
    return true;
  } catch (error) {
    if (generations.isCurrent(generation)) onError?.(error);
    return false;
  }
}

export type DraftSection = 'meta' | 'permissions' | 'members';

type GroupState = Pick<AccessGroupDto, 'name' | 'description' | 'permissions' | 'scopes' | 'members'>;

/**
 * Drafts after a conflict (409: the group changed in another session). Three-way per section, against the server
 * state the drafts were made from (`base`) and the new one (`latest`):
 * - not edited here → the latest server state (an untouched section never resends an old value);
 * - edited here, unchanged there → the local edit stays for a new save;
 * - edited on both sides → the local edit is dropped and the section is listed in `discarded` (say so to the user).
 */
export function draftsAfterConflict(base: GroupState, latest: GroupState, drafts: GroupDrafts): { drafts: GroupDrafts; discarded: DraftSection[] } {
  const baseDrafts = draftsAfterSave('all', base, drafts);
  const latestDrafts = draftsAfterSave('all', latest, drafts);
  const sections: Record<DraftSection, Array<keyof GroupDrafts>> = {
    meta: ['name', 'description'],
    permissions: ['permissions', 'scopes'],
    members: ['memberIds'],
  };
  const equal = (key: keyof GroupDrafts, a: GroupDrafts, b: GroupDrafts) => {
    if (key === 'scopes') return sameScopes(a.scopes, b.scopes);
    if (key === 'permissions' || key === 'memberIds') return sameSet(a[key] as unknown[], b[key] as unknown[]);
    return String(a[key]).trim() === String(b[key]).trim();
  };
  const result: GroupDrafts = { ...latestDrafts };
  const discarded: DraftSection[] = [];
  for (const [section, keys] of Object.entries(sections) as Array<[DraftSection, Array<keyof GroupDrafts>]>) {
    const editedHere = keys.some((key) => !equal(key, drafts, baseDrafts));
    if (!editedHere) continue;
    const changedThere = keys.some((key) => !equal(key, latestDrafts, baseDrafts));
    if (changedThere) {
      discarded.push(section);
      continue;
    }
    for (const key of keys) (result as unknown as Record<string, unknown>)[key] = drafts[key];
  }
  return { drafts: result, discarded };
}

/**
 * One save and its reloads in order (the user card): a reload asked for while a save runs is not sent in parallel —
 * it runs once, after the save finished (its result applied), so it reads the state that includes the save.
 */
export function createSaveReloadCoordinator() {
  let saving = false;
  let pending: (() => void) | null = null;
  return {
    get saving(): boolean {
      return saving;
    },
    /** Runs `run` now, or once after the running save (several requests during a save collapse into one). */
    reload(run: () => void): void {
      if (saving) {
        pending = run;
        return;
      }
      run();
    },
    async save<T>(command: () => Promise<T>): Promise<T | undefined> {
      if (saving) return undefined;
      saving = true;
      try {
        return await command();
      } finally {
        saving = false;
        const next = pending;
        pending = null;
        next?.();
      }
    },
  };
}
