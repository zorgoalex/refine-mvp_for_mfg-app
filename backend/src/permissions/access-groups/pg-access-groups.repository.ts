import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import {
  ADMINISTRATION_PERMISSIONS,
  assertAdministrationRemains,
  bumpAuthorizationVersion,
  lockAuthorizationState,
} from '../authorization-command-guard';
import { claimIdempotency, completeIdempotency, idempotencyRequestHash } from '../authorization-idempotency';
import type { CurrentUser } from '../current-user';
import {
  HASURA_UNCLOSED_PERMISSIONS,
  hasuraFinancialsState,
  hasuraFollowsPermissions,
} from '../hasura-unclosed-permissions';
import type { PermissionName } from '../permissions';
import {
  ALLOWED_SCOPE_VALUES,
  applyPermissionDependencies,
  DANGEROUS_PERMISSIONS,
  PermissionsService,
  ROLE_POLICY_SCOPE_KEYS,
} from '../permissions.service';
import type {
  AccessGroupDto,
  AccessGroupMemberDto,
  AccessGroupScopes,
  AccessGroupSummaryDto,
  AccessGroupsListDto,
  CreateAccessGroupRequest,
  DeleteAccessGroupRequest,
  ReplaceAccessGroupMembersRequest,
  ReplaceAccessGroupPermissionsRequest,
  ReplaceUserAccessGroupsRequest,
  UpdateAccessGroupRequest,
  UpdateAccessGroupsSettingsRequest,
  UserAuthorizationSourcesDto,
} from './access-groups.types';

/** Who runs a command and how to recognise its repeat (plan §4.2: the key is required for group commands). */
export interface AccessGroupsCommandContext {
  currentUser: CurrentUser;
  requestId: string;
  idempotencyKey: string;
}

interface AuditEntry {
  event: string;
  entityType: 'access_group' | 'user' | 'permissions_state';
  entityId: string;
  relatedUserId?: number | null;
  before: unknown;
  after: unknown;
}

interface Applied<T> {
  changed: boolean;
  audits: AuditEntry[];
  /**
   * Users whose effective grants the command may change, and their grants read under the command's locks before the
   * change (for the narrowing check and the event). A change that touches nobody's rights (a new group, a new name)
   * does not raise the authorization version, so no token goes stale for it.
   */
  affectedUserIds: readonly number[];
  grantsBefore?: Grants;
  /** The switch itself: always an authorization change. */
  forceVersion?: boolean;
  /** The target when it is known only after the change (a new group); default: the entity id of the command. */
  entityId?: string;
  build: (versionAfter: number | null) => Promise<T>;
}

type UserGrants = { permissions: Set<string>; scopes: Map<string, Set<string>> };
type Grants = Map<number, UserGrants>;
type QueryClient = Pick<TransactionClient, 'query'>;

const SOURCE = 'access_groups_api';
const USERS_SOURCE = 'users_api';
const SCOPE_KEYS = new Set<string>(ROLE_POLICY_SCOPE_KEYS);

/**
 * Access groups (plan spec_erp/plans/access-groups/2026-10-29-access-groups-plan-v6.md, stage 2): commands under the
 * authorization command protocol and the reads of the configuration screen. Every command runs in one transaction:
 * permissions_state FOR UPDATE → Idempotency-Key claimed (a completed repeat returns its stored answer before any
 * version check) → the actor checked again on fresh data → groups, then users locked in id order → versions compared →
 * change → narrowing check (Hasura must already enforce what the command takes away) → lockout check (an administrator
 * by effective rights and, while groups are on, by role) → version up → audit → event `authorization.changed` → answer
 * stored. A command that changes nothing writes no version, audit or event.
 */
@Injectable()
export class PgAccessGroupsRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  // ---------------------------------------------------------------- reads

  async list(): Promise<AccessGroupsListDto> {
    return this.readList(this.database);
  }

  async get(groupId: number): Promise<AccessGroupDto> {
    return this.readGroup(this.database, groupId);
  }

  async userAuthorization(userId: number, client: QueryClient = this.database): Promise<UserAuthorizationSourcesDto> {
    const user = await client.query<{ user_id: string; username: string; role_code: string | null; is_active: boolean; row_version: string; enabled: boolean }>(
      `SELECT u.user_id, u.username, r.role_code, u.is_active, u.row_version, ps.access_groups_enabled AS enabled
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id CROSS JOIN permissions_state ps
       WHERE u.user_id = $1 AND ps.id`,
      [userId],
    );
    const row = user.rows[0];
    if (!row) throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
    const groups = await client.query<{ group_id: string; code: string; name: string; is_active: boolean }>(
      `SELECT ag.group_id, ag.code, ag.name, ag.is_active FROM user_access_groups uag
       JOIN access_groups ag ON ag.group_id = uag.group_id WHERE uag.user_id = $1 ORDER BY ag.name`,
      [userId],
    );
    // Sources of what the user effectively holds now: the role, and active groups only while the switch is on.
    const permissions = await client.query<{ permission_name: PermissionName; sources: string[] }>(
      `SELECT g.permission_name, array_agg(g.source ORDER BY g.source) AS sources FROM (
         SELECT rp.permission_name, 'role' AS source FROM users u
           JOIN role_permissions rp ON rp.role_id = u.role_id AND rp.is_enabled
           JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active
           WHERE u.user_id = $1
         UNION ALL
         SELECT agp.permission_name, 'group:' || ag.code FROM user_access_groups uag
           JOIN access_groups ag ON ag.group_id = uag.group_id AND ag.is_active
           JOIN access_group_permissions agp ON agp.group_id = ag.group_id
           JOIN permissions_catalog pc ON pc.permission_name = agp.permission_name AND pc.is_active
           JOIN permissions_state ps ON ps.id AND ps.access_groups_enabled
           WHERE uag.user_id = $1
       ) g JOIN permissions_catalog pc ON pc.permission_name = g.permission_name
       GROUP BY g.permission_name, pc.sort_order ORDER BY pc.sort_order, g.permission_name`,
      [userId],
    );
    const scopes = await client.query<{ scope_key: string; scope_value: string; sources: string[] }>(
      `SELECT g.scope_key, g.scope_value, array_agg(g.source ORDER BY g.source) AS sources FROM (
         SELECT rps.scope_key, rps.scope_value, 'role' AS source FROM users u
           JOIN role_policy_scopes rps ON rps.role_id = u.role_id AND rps.scope_value <> 'none'
           WHERE u.user_id = $1
         UNION ALL
         SELECT ags.scope_key, ags.scope_value, 'group:' || ag.code FROM user_access_groups uag
           JOIN access_groups ag ON ag.group_id = uag.group_id AND ag.is_active
           JOIN access_group_scopes ags ON ags.group_id = ag.group_id
           JOIN permissions_state ps ON ps.id AND ps.access_groups_enabled
           WHERE uag.user_id = $1
       ) g GROUP BY g.scope_key, g.scope_value ORDER BY g.scope_key, g.scope_value`,
      [userId],
    );
    return {
      userId: Number(row.user_id),
      username: row.username,
      roleCode: row.role_code,
      isActive: row.is_active,
      rowVersion: Number(row.row_version),
      accessGroupsEnabled: row.enabled === true,
      groups: groups.rows.map((group) => ({ groupId: Number(group.group_id), code: group.code, name: group.name, isActive: group.is_active })),
      permissions: permissions.rows.map((item) => ({ permission: item.permission_name, sources: item.sources })),
      scopes: scopes.rows.map((item) => ({ scopeKey: item.scope_key, scopeValue: item.scope_value, sources: item.sources })),
    };
  }

  // ---------------------------------------------------------------- commands

  async create(ctx: AccessGroupsCommandContext, request: CreateAccessGroupRequest): Promise<AccessGroupDto> {
    const code = request.code.trim();
    return this.runCommand(ctx, 'access_groups.create', 'access_group', 'new', request, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM access_groups WHERE code = $1', [code]);
      if (exists.rowCount) throw new ApiError(409, 'ACCESS_GROUP_CODE_TAKEN', 'Группа с таким кодом уже есть', { code });
      const inserted = await tx.query<{ group_id: string }>(
        `INSERT INTO access_groups (code, name, description, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING group_id`,
        [code, request.name.trim(), normalizeText(request.description), actorId(ctx)],
      );
      const groupId = Number(inserted.rows[0].group_id);
      const after = await this.readGroup(tx, groupId);
      return {
        // A new group has no permissions and no members: nobody's rights change, but the change is audited.
        changed: true,
        entityId: String(groupId),
        affectedUserIds: [],
        audits: [{ event: 'access_groups.create', entityType: 'access_group', entityId: String(groupId), before: null, after: auditGroup(after) }],
        build: async () => this.readGroup(tx, groupId),
      };
    });
  }

  async update(ctx: AccessGroupsCommandContext, groupId: number, request: UpdateAccessGroupRequest): Promise<AccessGroupDto> {
    return this.runCommand(ctx, 'access_groups.update', 'access_group', String(groupId), request, async (tx) => {
      const before = await this.lockGroup(tx, groupId, request.version);
      const next = {
        name: request.name === undefined ? before.name : request.name.trim(),
        description: request.description === undefined ? before.description : normalizeText(request.description),
        isActive: request.isActive === undefined ? before.isActive : request.isActive,
      };
      if (next.name === before.name && next.description === before.description && next.isActive === before.isActive) {
        return unchanged(() => this.readGroup(tx, groupId));
      }
      const members = before.members.map((member) => member.userId);
      const grantsBefore = await this.lockUsers(tx, members);
      await tx.query(
        `UPDATE access_groups SET name = $2, description = $3, is_active = $4, version = version + 1, updated_by = $5, updated_at = now()
         WHERE group_id = $1`,
        [groupId, next.name, next.description, next.isActive, actorId(ctx)],
      );
      const activityChanged = next.isActive !== before.isActive;
      const after = await this.readGroup(tx, groupId);
      const event = !activityChanged ? 'access_groups.update' : next.isActive ? 'access_groups.activate' : 'access_groups.deactivate';
      return {
        changed: true,
        affectedUserIds: activityChanged ? members : [],
        grantsBefore,
        audits: [{ event, entityType: 'access_group', entityId: String(groupId), before: auditGroup(before), after: auditGroup(after) }],
        build: async () => this.readGroup(tx, groupId),
      };
    });
  }

  async replacePermissions(ctx: AccessGroupsCommandContext, groupId: number, request: ReplaceAccessGroupPermissionsRequest): Promise<AccessGroupDto> {
    return this.runCommand(ctx, 'access_groups.permissions.update', 'access_group', String(groupId), request, async (tx) => {
      const before = await this.lockGroup(tx, groupId, request.version);
      const permissions = await this.normalizePermissions(tx, request.permissions);
      const scopes = normalizeScopes(request.scopes);
      const added = permissions.filter((permission) => !before.permissions.includes(permission));
      const dangerous = added.filter((permission) => DANGEROUS_PERMISSIONS.has(permission));
      if (dangerous.length > 0 && request.confirmDangerous !== true) {
        throw new ApiError(422, 'DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED', 'Подтвердите выдачу опасных прав группе', { permissions: dangerous });
      }
      if (sameSet(before.permissions, permissions) && sameScopes(before.scopes, scopes)) {
        return unchanged(() => this.readGroup(tx, groupId));
      }
      const members = before.members.map((member) => member.userId);
      const grantsBefore = await this.lockUsers(tx, members);
      await tx.query('DELETE FROM access_group_permissions WHERE group_id = $1', [groupId]);
      await tx.query(
        'INSERT INTO access_group_permissions (group_id, permission_name) SELECT $1, unnest($2::text[])',
        [groupId, permissions],
      );
      await tx.query('DELETE FROM access_group_scopes WHERE group_id = $1', [groupId]);
      for (const [scopeKey, values] of Object.entries(scopes)) {
        await tx.query(
          'INSERT INTO access_group_scopes (group_id, scope_key, scope_value) SELECT $1, $2, unnest($3::text[])',
          [groupId, scopeKey, values],
        );
      }
      await tx.query(
        'UPDATE access_groups SET version = version + 1, updated_by = $2, updated_at = now() WHERE group_id = $1',
        [groupId, actorId(ctx)],
      );
      const after = await this.readGroup(tx, groupId);
      return {
        changed: true,
        affectedUserIds: members,
        grantsBefore,
        audits: [{
          event: 'access_groups.permissions.update', entityType: 'access_group', entityId: String(groupId),
          before: { permissions: before.permissions, scopes: before.scopes },
          after: { permissions: after.permissions, scopes: after.scopes },
        }],
        build: async () => this.readGroup(tx, groupId),
      };
    });
  }

  async replaceMembers(ctx: AccessGroupsCommandContext, groupId: number, request: ReplaceAccessGroupMembersRequest): Promise<AccessGroupDto> {
    const wanted = uniqueIds(request.userIds);
    return this.runCommand(ctx, 'access_groups.members.update', 'access_group', String(groupId), { ...request, userIds: wanted }, async (tx) => {
      const before = await this.lockGroup(tx, groupId, request.version);
      const current = before.members.map((member) => member.userId);
      const added = wanted.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !wanted.includes(id));
      if (added.length === 0 && removed.length === 0) return unchanged(() => this.readGroup(tx, groupId));
      const grantsBefore = await this.lockUsers(tx, [...added, ...removed], { requireExisting: added });
      if (removed.length) {
        await tx.query('DELETE FROM user_access_groups WHERE group_id = $1 AND user_id = ANY($2::bigint[])', [groupId, removed]);
      }
      if (added.length) {
        await tx.query(
          'INSERT INTO user_access_groups (user_id, group_id, added_by) SELECT unnest($2::bigint[]), $1, $3',
          [groupId, added, actorId(ctx)],
        );
      }
      await tx.query('UPDATE access_groups SET version = version + 1, updated_by = $2, updated_at = now() WHERE group_id = $1', [groupId, actorId(ctx)]);
      await bumpUserRows(tx, [...added, ...removed]);
      return {
        changed: true,
        affectedUserIds: [...added, ...removed],
        grantsBefore,
        audits: [
          ...added.map((userId) => memberAudit('access_groups.member.add', groupId, userId, false, true)),
          ...removed.map((userId) => memberAudit('access_groups.member.remove', groupId, userId, true, false)),
        ],
        build: async () => this.readGroup(tx, groupId),
      };
    });
  }

  async remove(ctx: AccessGroupsCommandContext, groupId: number, request: DeleteAccessGroupRequest): Promise<{ groupId: number; deleted: true }> {
    return this.runCommand(ctx, 'access_groups.delete', 'access_group', String(groupId), request, async (tx) => {
      const before = await this.lockGroup(tx, groupId, request.version);
      if (before.isActive || before.members.length > 0) {
        throw new ApiError(409, 'ACCESS_GROUP_NOT_EMPTY', 'Удалить можно только неактивную группу без участников', {
          isActive: before.isActive, memberCount: before.members.length,
        });
      }
      await tx.query('DELETE FROM access_groups WHERE group_id = $1', [groupId]);
      return {
        changed: true,
        affectedUserIds: [],
        audits: [{ event: 'access_groups.delete', entityType: 'access_group', entityId: String(groupId), before: auditGroup(before), after: null }],
        build: async () => ({ groupId, deleted: true as const }),
      };
    });
  }

  async updateSettings(ctx: AccessGroupsCommandContext, request: UpdateAccessGroupsSettingsRequest): Promise<AccessGroupsListDto> {
    return this.runCommand(ctx, 'access_groups.settings.update', 'permissions_state', 'access_groups_enabled', request, async (tx, versionBefore) => {
      if (request.version !== versionBefore) {
        throw new ApiError(409, 'PERMISSIONS_VERSION_CONFLICT', 'Права изменились, обновите страницу', { expected: request.version, actual: versionBefore });
      }
      const current = await tx.query<{ enabled: boolean }>('SELECT access_groups_enabled AS enabled FROM permissions_state WHERE id = true');
      const enabled = current.rows[0]?.enabled === true;
      if (enabled === request.enabled) return unchanged(() => this.readList(tx));
      if (request.enabled) {
        // Groups widen what Hasura shows only through the 0B predicates; F2 must hold the money columns (plan §4.2).
        const follows = await hasuraFollowsPermissions(tx);
        const financials = await hasuraFinancialsState(tx);
        if (!follows || financials !== 'closed') {
          throw new ApiError(409, 'ACCESS_GROUPS_HASURA_NOT_CLOSED',
            'Группы можно включить, только когда Hasura проверяет права пользователя и суммы закрыты (шаги B и F2)', {
              hasuraFollowsPermissions: follows, hasuraFinancialsState: financials,
            });
        }
      }
      const members = await tx.query<{ user_id: string }>('SELECT DISTINCT user_id FROM user_access_groups ORDER BY user_id');
      const affected = members.rows.map((row) => Number(row.user_id));
      const grantsBefore = await this.lockUsers(tx, affected);
      await tx.query('UPDATE permissions_state SET access_groups_enabled = $1, updated_at = now() WHERE id = true', [request.enabled]);
      return {
        changed: true,
        affectedUserIds: affected,
        grantsBefore,
        forceVersion: true,
        audits: [{
          event: 'access_groups.settings.update', entityType: 'permissions_state', entityId: 'access_groups_enabled',
          before: { enabled }, after: { enabled: request.enabled },
        }],
        build: async (versionAfter) => {
          const list = await this.readList(tx);
          return { ...list, permissionsVersion: versionAfter ?? list.permissionsVersion };
        },
      };
    });
  }

  async replaceUserGroups(ctx: AccessGroupsCommandContext, userId: number, request: ReplaceUserAccessGroupsRequest): Promise<UserAuthorizationSourcesDto> {
    const wanted = uniqueIds(request.groupIds);
    return this.runCommand(ctx, 'users.access_groups.update', 'user', String(userId), { ...request, groupIds: wanted }, async (tx) => {
      const current = (await tx.query<{ group_id: string }>('SELECT group_id FROM user_access_groups WHERE user_id = $1', [userId]))
        .rows.map((row) => Number(row.group_id));
      const touched = uniqueIds([...current, ...wanted]);
      const groups = await tx.query<{ group_id: string }>(
        'SELECT group_id FROM access_groups WHERE group_id = ANY($1::bigint[]) ORDER BY group_id FOR UPDATE',
        [touched],
      );
      const found = new Set(groups.rows.map((row) => Number(row.group_id)));
      const missing = wanted.filter((id) => !found.has(id));
      if (missing.length) throw new ApiError(422, 'ACCESS_GROUP_NOT_FOUND', 'Группа не найдена', { groupIds: missing });
      const user = await tx.query<{ row_version: string }>('SELECT row_version FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!user.rows[0]) throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
      const grantsBefore = await readGrants(tx, [userId]);
      if (Number(user.rows[0].row_version) !== request.rowVersion) {
        throw new ApiError(409, 'USER_VERSION_CONFLICT', 'Пользователь изменился, обновите страницу', {
          expected: request.rowVersion, actual: Number(user.rows[0].row_version),
        });
      }
      const added = wanted.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !wanted.includes(id));
      if (added.length === 0 && removed.length === 0) return unchanged(() => this.userAuthorization(userId, tx));
      if (removed.length) await tx.query('DELETE FROM user_access_groups WHERE user_id = $1 AND group_id = ANY($2::bigint[])', [userId, removed]);
      if (added.length) {
        await tx.query('INSERT INTO user_access_groups (user_id, group_id, added_by) SELECT $1, unnest($2::bigint[]), $3', [userId, added, actorId(ctx)]);
      }
      await tx.query('UPDATE access_groups SET version = version + 1, updated_at = now() WHERE group_id = ANY($1::bigint[])', [[...added, ...removed]]);
      await bumpUserRows(tx, [userId]);
      return {
        changed: true,
        affectedUserIds: [userId],
        grantsBefore,
        audits: [{
          event: 'users.access_groups.update', entityType: 'user', entityId: String(userId), relatedUserId: userId,
          before: { groupIds: [...current].sort((a, b) => a - b) }, after: { groupIds: wanted },
        }],
        build: async () => this.userAuthorization(userId, tx),
      };
    }, USERS_SOURCE);
  }

  // ---------------------------------------------------------------- protocol

  private async runCommand<T>(
    ctx: AccessGroupsCommandContext,
    name: string,
    entityType: string,
    entityId: string,
    payload: unknown,
    plan: (tx: TransactionClient, versionBefore: number) => Promise<Applied<T>>,
    source = SOURCE,
  ): Promise<T> {
    const key = `access-groups:${ctx.idempotencyKey}`;
    const hash = idempotencyRequestHash(name, entityId, payload);
    return this.database.transaction(async (tx) => {
      const versionBefore = await lockAuthorizationState(tx, 'update');
      const replay = await claimIdempotency<T>(tx, { key, name, entityType, entityId, hash, actorUserId: actorId(ctx) });
      if (replay !== null) return replay;
      await this.reassertActor(tx, ctx.currentUser);

      const applied = await plan(tx, versionBefore);
      let result: T;
      if (!applied.changed) {
        result = await applied.build(null);
      } else {
        // Only users whose effective grants differ count (a group change while the switch is off, or one covered by
        // the role, changes nobody's rights): the global version, narrowing, lockout and the event follow them.
        const changedUsers = await usersWithChangedGrants(tx, applied.grantsBefore ?? new Map(), applied.affectedUserIds);
        const rightsChanged = applied.forceVersion === true || changedUsers.length > 0;
        let versionAfter = versionBefore;
        if (rightsChanged) {
          await assertNoUnclosedEffectiveNarrowing(tx, applied.grantsBefore ?? new Map(), changedUsers);
          await assertAdministrationRemains(tx);
          versionAfter = await bumpAuthorizationVersion(tx);
        }
        for (const entry of applied.audits) await writeAudit(tx, ctx, entry, source, versionBefore, versionAfter);
        if (rightsChanged) {
          await writeAuthorizationChanged(tx, ctx, name, { entityType, entityId: applied.entityId ?? entityId }, changedUsers, versionBefore, versionAfter);
        }
        result = await applied.build(rightsChanged ? versionAfter : null);
      }
      await completeIdempotency(tx, key, result);
      return result;
    });
  }

  private async reassertActor(tx: TransactionClient, currentUser: CurrentUser): Promise<void> {
    const actor = await this.permissions.loadUserAuthorization(currentUser.id, tx);
    if (!actor?.isActive || !actor.permissions.includes('system.superadmin') || !actor.permissions.includes('permissions.manage')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['system.superadmin', 'permissions.manage'],
      });
    }
  }

  /** The group FOR UPDATE with its version compared; also records the members' grants before the change. */
  private async lockGroup(tx: TransactionClient, groupId: number, version: number): Promise<AccessGroupDto> {
    const locked = await tx.query<{ version: string }>('SELECT version FROM access_groups WHERE group_id = $1 FOR UPDATE', [groupId]);
    if (!locked.rows[0]) throw new ApiError(404, 'ACCESS_GROUP_NOT_FOUND', 'Группа не найдена');
    if (Number(locked.rows[0].version) !== version) {
      throw new ApiError(409, 'ACCESS_GROUP_VERSION_CONFLICT', 'Группа изменилась, обновите страницу', { expected: version, actual: Number(locked.rows[0].version) });
    }
    return this.readGroup(tx, groupId);
  }

  /** Users FOR UPDATE in id order (plan §5.1); returns their grants before the change. */
  private async lockUsers(tx: TransactionClient, userIds: readonly number[], options: { requireExisting?: readonly number[] } = {}): Promise<Grants> {
    const ids = uniqueIds(userIds);
    if (ids.length === 0) return new Map();
    const locked = await tx.query<{ user_id: string }>('SELECT user_id FROM users WHERE user_id = ANY($1::bigint[]) ORDER BY user_id FOR UPDATE', [ids]);
    const found = new Set(locked.rows.map((row) => Number(row.user_id)));
    const missing = (options.requireExisting ?? []).filter((id) => !found.has(id));
    if (missing.length) throw new ApiError(422, 'USER_NOT_FOUND', 'Пользователь не найден', { userIds: missing });
    return readGrants(tx, ids);
  }

  private async normalizePermissions(tx: TransactionClient, requested: readonly string[]): Promise<PermissionName[]> {
    const catalog = await tx.query<{ permission_name: string; sort_order: number }>(
      'SELECT permission_name, sort_order FROM permissions_catalog WHERE is_active ORDER BY sort_order, permission_name',
    );
    const known = new Set(catalog.rows.map((row) => row.permission_name));
    const unknown = requested.filter((permission) => !known.has(permission));
    if (unknown.length) throw new ApiError(422, 'VALIDATION_ERROR', 'Неизвестное право', { permissions: unknown });
    const row: Record<string, boolean> = Object.fromEntries(catalog.rows.map((item) => [item.permission_name, requested.includes(item.permission_name)]));
    applyPermissionDependencies(row);
    return catalog.rows.map((item) => item.permission_name).filter((permission) => row[permission]) as PermissionName[];
  }

  private async readList(client: QueryClient): Promise<AccessGroupsListDto> {
    const state = await client.query<{ enabled: boolean; version: string }>('SELECT access_groups_enabled AS enabled, version FROM permissions_state WHERE id = true');
    const groups = await client.query<GroupSummaryRow>(GROUP_SUMMARY_SQL + ' ORDER BY ag.name, ag.group_id');
    return { enabled: state.rows[0]?.enabled === true, permissionsVersion: Number(state.rows[0]?.version ?? 0), groups: groups.rows.map(toSummary) };
  }

  private async readGroup(client: QueryClient, groupId: number): Promise<AccessGroupDto> {
    const summary = await client.query<GroupSummaryRow>(GROUP_SUMMARY_SQL + ' WHERE ag.group_id = $1', [groupId]);
    if (!summary.rows[0]) throw new ApiError(404, 'ACCESS_GROUP_NOT_FOUND', 'Группа не найдена');
    const permissions = await client.query<{ permission_name: PermissionName }>(
      `SELECT agp.permission_name FROM access_group_permissions agp JOIN permissions_catalog pc ON pc.permission_name = agp.permission_name
       WHERE agp.group_id = $1 ORDER BY pc.sort_order, agp.permission_name`,
      [groupId],
    );
    const scopes = await client.query<{ scope_key: string; scope_value: string }>(
      'SELECT scope_key, scope_value FROM access_group_scopes WHERE group_id = $1 ORDER BY scope_key, scope_value',
      [groupId],
    );
    const members = await client.query<{ user_id: string; username: string; role_code: string | null; is_active: boolean }>(
      `SELECT u.user_id, u.username, r.role_code, u.is_active FROM user_access_groups uag JOIN users u ON u.user_id = uag.user_id
       LEFT JOIN roles r ON r.role_id = u.role_id WHERE uag.group_id = $1 ORDER BY u.username, u.user_id`,
      [groupId],
    );
    const groupedScopes: AccessGroupScopes = {};
    for (const row of scopes.rows) (groupedScopes[row.scope_key] ??= []).push(row.scope_value);
    return {
      ...toSummary(summary.rows[0]),
      permissions: permissions.rows.map((row) => row.permission_name),
      scopes: groupedScopes,
      members: members.rows.map((row): AccessGroupMemberDto => ({ userId: Number(row.user_id), username: row.username, roleCode: row.role_code, isActive: row.is_active })),
    };
  }

}

// ---------------------------------------------------------------------------- helpers

interface GroupSummaryRow {
  group_id: string; code: string; name: string; description: string | null; is_active: boolean; version: string;
  member_count: string; permission_count: string;
}

const GROUP_SUMMARY_SQL = `
  SELECT ag.group_id, ag.code, ag.name, ag.description, ag.is_active, ag.version,
    (SELECT count(*) FROM user_access_groups uag WHERE uag.group_id = ag.group_id) AS member_count,
    (SELECT count(*) FROM access_group_permissions agp WHERE agp.group_id = ag.group_id) AS permission_count
  FROM access_groups ag`;

function toSummary(row: GroupSummaryRow): AccessGroupSummaryDto {
  return {
    groupId: Number(row.group_id), code: row.code, name: row.name, description: row.description, isActive: row.is_active,
    version: Number(row.version), memberCount: Number(row.member_count), permissionCount: Number(row.permission_count),
  };
}

function unchanged<T>(build: () => Promise<T>): Applied<T> {
  return { changed: false, audits: [], affectedUserIds: [], build };
}

function auditGroup(group: AccessGroupDto): Record<string, unknown> {
  return {
    code: group.code, name: group.name, description: group.description, isActive: group.isActive,
    permissions: group.permissions, scopes: group.scopes, memberIds: group.members.map((member) => member.userId),
  };
}

function memberAudit(event: string, groupId: number, userId: number, before: boolean, after: boolean): AuditEntry {
  return { event, entityType: 'access_group', entityId: String(groupId), relatedUserId: userId, before: { member: before }, after: { member: after } };
}

function normalizeText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids.map(Number))].sort((a, b) => a - b);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

function sameScopes(a: AccessGroupScopes, b: AccessGroupScopes): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => sameSet(a[key] ?? [], b[key] ?? []));
}

/** Scope sets of a group: known keys, allowed values without 'none' (else 422 INVALID_SCOPE_VALUE), sorted. */
export function normalizeScopes(scopes: AccessGroupScopes): AccessGroupScopes {
  const result: AccessGroupScopes = {};
  for (const [key, values] of Object.entries(scopes ?? {})) {
    const allowed = (ALLOWED_SCOPE_VALUES as Record<string, readonly string[]>)[key];
    const invalid = !SCOPE_KEYS.has(key) || !allowed ? values : values.filter((value) => value === 'none' || !allowed.includes(value));
    if (invalid.length > 0) throw new ApiError(422, 'INVALID_SCOPE_VALUE', 'Недопустимое значение области', { scopeKey: key, values: invalid });
    const unique = [...new Set(values)].sort();
    if (unique.length > 0) result[key] = unique;
  }
  return result;
}

function actorId(ctx: AccessGroupsCommandContext): number | null {
  const id = Number(ctx.currentUser.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function bumpUserRows(tx: TransactionClient, userIds: readonly number[]): Promise<void> {
  if (userIds.length === 0) return;
  await tx.query('UPDATE users SET row_version = row_version + 1 WHERE user_id = ANY($1::bigint[])', [uniqueIds(userIds)]);
}

async function readGrants(tx: TransactionClient, userIds: readonly number[]): Promise<Grants> {
  const grants: Grants = new Map(userIds.map((id) => [id, { permissions: new Set<string>(), scopes: new Map<string, Set<string>>() }]));
  if (userIds.length === 0) return grants;
  const permissions = await tx.query<{ user_id: string; permission_name: string }>(
    'SELECT user_id, permission_name FROM user_effective_permissions WHERE user_id = ANY($1::bigint[])', [userIds],
  );
  for (const row of permissions.rows) grants.get(Number(row.user_id))?.permissions.add(row.permission_name);
  const scopes = await tx.query<{ user_id: string; scope_key: string; scope_value: string }>(
    'SELECT user_id, scope_key, scope_value FROM user_effective_scopes WHERE user_id = ANY($1::bigint[])', [userIds],
  );
  for (const row of scopes.rows) {
    const scopesOf = grants.get(Number(row.user_id))?.scopes;
    if (!scopesOf) continue;
    if (!scopesOf.has(row.scope_key)) scopesOf.set(row.scope_key, new Set());
    scopesOf.get(row.scope_key)!.add(row.scope_value);
  }
  return grants;
}

/** Affected users whose effective permissions or scopes differ from `before` (read again in the same transaction). */
async function usersWithChangedGrants(tx: TransactionClient, before: Grants, userIds: readonly number[]): Promise<number[]> {
  const ids = uniqueIds(userIds);
  if (ids.length === 0) return [];
  const after = await readGrants(tx, ids);
  const key = (grants: UserGrants | undefined) => grants
    ? JSON.stringify([[...grants.permissions].sort(), [...grants.scopes].map(([scope, values]) => [scope, [...values].sort()]).sort()])
    : '';
  return ids.filter((id) => key(before.get(id)) !== key(after.get(id)));
}

/**
 * A change of groups may take rights away from users (a member removed, a permission or scope taken off, a group
 * deactivated, the switch turned off). Like the roles matrix (PERMISSION_NARROWING_BLOCKED), it is refused while Hasura
 * would still serve what the backend stops allowing: every narrowing while Hasura does not follow the effective
 * permissions (step B not applied), and orders.view_financials while the money columns are open (step F2 not closed).
 */
export async function assertNoUnclosedEffectiveNarrowing(tx: TransactionClient, before: Grants, userIds: readonly number[]): Promise<void> {
  if (userIds.length === 0) return;
  const after = await readGrants(tx, userIds);
  const follows = await hasuraFollowsPermissions(tx);
  const financials = await hasuraFinancialsState(tx);
  const blocked: Array<{ userId: number; permission?: string; scope?: string; reason: string }> = [];
  for (const userId of userIds) {
    const was = before.get(userId);
    const now = after.get(userId);
    if (!was || !now) continue;
    for (const permission of was.permissions) {
      if (now.permissions.has(permission)) continue;
      const unclosed = HASURA_UNCLOSED_PERMISSIONS[permission as PermissionName];
      if (!follows) blocked.push({ userId, permission, reason: 'прямые запросы к базе (Hasura) сейчас не проверяют права пользователя' });
      else if (unclosed && financials !== unclosed.closedBy) blocked.push({ userId, permission, reason: unclosed.reason });
    }
    if (!follows) {
      for (const [scope, values] of was.scopes) {
        const nowValues = now.scopes.get(scope) ?? new Set<string>();
        if (nowValues.has('all')) continue;
        if ([...values].some((value) => !nowValues.has(value))) {
          blocked.push({ userId, scope, reason: 'прямые запросы к базе (Hasura) сейчас не проверяют права пользователя' });
        }
      }
    }
  }
  if (blocked.length > 0) {
    throw new ApiError(422, 'PERMISSION_NARROWING_BLOCKED', `Это изменение пока нельзя сделать: ${blocked[0].reason}`, {
      blocked, hasuraFollowsPermissions: follows, hasuraFinancialsState: financials,
    });
  }
}

async function writeAudit(
  tx: TransactionClient,
  ctx: AccessGroupsCommandContext,
  entry: AuditEntry,
  source: string,
  versionBefore: number,
  versionAfter: number,
): Promise<void> {
  // The central writer: redaction of keys and of secrets inside strings (a description may carry anything).
  await auditService.record(tx, {
    event: entry.event,
    entityType: entry.entityType,
    entityId: entry.entityId,
    actorUserId: actorId(ctx),
    actorUsername: ctx.currentUser.username,
    actorRole: ctx.currentUser.role,
    requestId: ctx.requestId,
    source,
    relatedUserId: entry.relatedUserId ?? null,
    before: asRecord(entry.before),
    after: asRecord(entry.after),
    diff: { before: entry.before, after: entry.after },
    metadata: { permissionsVersionBefore: versionBefore, permissionsVersionAfter: versionAfter, idempotencyKey: ctx.idempotencyKey },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : (value as Record<string, unknown>);
}

/** Domain event (plan §4.4): affected users at the moment of the command; one per committed change (global version). */
async function writeAuthorizationChanged(
  tx: TransactionClient,
  ctx: AccessGroupsCommandContext,
  command: string,
  target: { entityType: string; entityId: string },
  affectedUserIds: readonly number[],
  versionBefore: number,
  versionAfter: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ('authorization.changed', $1, $2, $3::jsonb, $4) ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      target.entityType,
      target.entityId,
      JSON.stringify({
        command, entityType: target.entityType, entityId: target.entityId,
        actorUserId: actorId(ctx), requestId: ctx.requestId, affectedUserIds: uniqueIds(affectedUserIds),
        permissionsVersionBefore: versionBefore, permissionsVersionAfter: versionAfter,
      }),
      `authorization.changed:permissions-v${versionAfter}`,
    ],
  );
}

export { ADMINISTRATION_PERMISSIONS };
