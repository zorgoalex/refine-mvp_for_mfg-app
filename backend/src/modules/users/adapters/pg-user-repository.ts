import { createHash, createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { DatabaseService } from '../../../database/database.service';
import { assertNoAccountEscalation } from '../../../permissions/account-escalation';
import {
  assertAdministrationRemains,
  bumpAuthorizationVersion,
  lockAuthorizationState,
} from '../../../permissions/authorization-command-guard';
import type { CurrentUser } from '../../../permissions/current-user';
import { loadEvaluationUserWith } from '../../../permissions/user-authorization-snapshot';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import {
  getPermissionsForRole,
  isUserRole,
  mapRoleIdToRole,
  mapRoleToRoleId,
} from '../../../permissions/permissions';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { UserDto, UserListResponseDto } from '../dto/user.dto';
import { UserAlreadyExistsError } from '../errors/user.errors';
import type {
  ChangeUserPasswordCommand,
  CreateUserCommand,
  GetUserByIdCommand,
  ListUsersCommand,
  UpdateUserCommand,
  UserActivationCommand,
  UserCommandName,
  UserCommandRecheck,
  UserRepositoryPort,
} from '../application/user-command.types';

const PASSWORD_HASH_ROUNDS = 12;
const DEFAULT_REQUEST_ID = 'users-adapter';

interface UserRow extends QueryResultRow {
  user_id: string | number;
  username: string;
  email: string | null;
  full_name: string | null;
  role_id: string | number;
  role_code: string | null;
  employee_id: string | number | null;
  is_active: boolean;
  created_at: string | Date;
  updated_at: string | Date | null;
  row_version: string | number;
}

interface CountRow extends QueryResultRow {
  total: string | number;
}

interface RevokedSessionsRow extends QueryResultRow {
  revoked_sessions: string | number;
}

type UserDatabase = DatabaseClient & {
  transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T>;
};

export class PgUserRepository implements UserRepositoryPort {
  constructor(
    private readonly database: UserDatabase | DatabaseService,
    private readonly permissions?: Pick<PermissionsService, 'loadUserAuthorization'>,
    /**
     * Server secret for the password part of idempotent requests (HMAC; no derivative of a password is stored
     * that could be checked without it). Without it, commands carrying a password run without idempotency.
     */
    private readonly idempotencySecret?: string,
  ) {}

  /**
   * A completed command with this Idempotency-Key, actor and payload: its stored response (plan §5.3). Read before any
   * policy check, so a repeat after a lost response is answered even when the actor's rights changed since (the
   * response is what this command already returned to him). Another payload or actor → 409; unknown or unfinished
   * key → null (the command runs, and its own claim decides).
   */
  async findCompletedReplay<T>(name: UserCommandName, command: UserCommandInput): Promise<T | null> {
    const spec = this.idempotencySpec(name, command);
    if (!spec) return null;
    const result = await this.database.query<{ request_hash: string; response_json: T | null; status: string; actor_user_id: string | number | null }>(
      'SELECT request_hash, response_json, status, actor_user_id FROM command_idempotency_keys WHERE idempotency_key = $1',
      [spec.key],
    );
    const row = result.rows[0];
    if (!row) return null;
    assertSameRequest(row, spec);
    return row.status === 'completed' && row.response_json ? row.response_json : null;
  }

  private idempotencySpec(name: UserCommandName, command: UserCommandInput): IdempotencySpec | null {
    if (!command.idempotencyKey) return null;
    let payload: unknown = {};
    let entityId = 'userId' in command ? String(command.userId) : 'new';
    if (name === 'users.create') {
      const { password, ...rest } = (command as CreateUserCommand).dto;
      const proof = this.passwordProof(password);
      if (!proof) return null;
      payload = { ...rest, passwordProof: proof };
      entityId = 'new';
    } else if (name === 'users.change_password') {
      const { newPassword, ...rest } = (command as ChangeUserPasswordCommand).dto;
      const proof = this.passwordProof(newPassword);
      if (!proof) return null;
      payload = { ...rest, passwordProof: proof };
    } else if (name === 'users.update') {
      payload = (command as UpdateUserCommand).dto;
    }
    return {
      name,
      key: `users:${command.idempotencyKey}`,
      entityId,
      actorUserId: toNullableUserId(command.currentUser.id),
      hash: requestHash(name, entityId, payload),
    };
  }

  private passwordProof(password: string): string | null {
    if (!this.idempotencySecret) return null;
    return createHmac('sha256', this.idempotencySecret).update(`users-command-password:v1\0${password}`).digest('hex');
  }

  async listUsers(command: ListUsersCommand): Promise<UserListResponseDto> {
    const params: unknown[] = [];
    const where = buildListWhere(command, params);
    const countResult = await this.database.query<CountRow>(
      `
      SELECT COUNT(*)::int AS total
      FROM users u
      LEFT JOIN roles r ON r.role_id = u.role_id
      ${where}
      `,
      params,
    );
    const limitIndex = params.push(command.query.pageSize);
    const offsetIndex = params.push((command.query.page - 1) * command.query.pageSize);
    const usersResult = await this.database.query<UserRow>(
      `
      SELECT
        u.user_id, u.username, u.email, u.full_name, u.role_id, r.role_code,
        u.employee_id, u.is_active, u.created_at, u.updated_at, u.row_version
      FROM users u
      LEFT JOIN roles r ON r.role_id = u.role_id
      ${where}
      ORDER BY u.created_at DESC, u.user_id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      params,
    );
    const total = toNumber(countResult.rows[0]?.total ?? 0);

    return {
      data: await this.mapUserRows(usersResult.rows),
      pagination: {
        page: command.query.page,
        pageSize: command.query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / command.query.pageSize)),
      },
    };
  }

  async getUserById(command: GetUserByIdCommand): Promise<UserDto | null> {
    return this.getUserByIdInternal(this.database, command.userId);
  }

  async createUser(command: CreateUserCommand): Promise<UserDto> {
    const passwordHash = await bcrypt.hash(command.dto.password, PASSWORD_HASH_ROUNDS);
    const roleId = mapRoleToRoleId(command.dto.role);
    const email = normalizeEmail(command.dto.email, command.dto.username);

    return this.runCommand(command, this.idempotencySpec('users.create', command), async (tx, versionBefore) => {
      await this.recheckActor(tx, command, null);
      try {
        const created = await tx.query<UserRow>(
          `
          INSERT INTO users (
            username, email, password_hash, role_id, employee_id, full_name, is_active,
            created_by, edited_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          RETURNING
            user_id, username, email, full_name, role_id,
            (SELECT role_code FROM roles WHERE role_id = $4) AS role_code,
            employee_id, is_active, created_at, updated_at, row_version
          `,
          [
            command.dto.username,
            email,
            passwordHash,
            roleId,
            command.dto.employeeId ?? null,
            normalizeNullable(command.dto.fullName),
            command.dto.isActive ?? true,
            toNullableUserId(command.currentUser.id),
          ],
        );
        // The new account may not have permissions or scopes its creator lacks (access groups 0A.4).
        await assertNoAccountEscalation(tx, command.currentUser.id, created.rows[0].user_id);
        const user = await this.mapUserRow(created.rows[0], tx);
        const versions = { permissionsVersionBefore: versionBefore, permissionsVersionAfter: versionBefore };

        await writeUserAudit(tx, {
          command,
          action: 'users.create',
          entityId: user.id,
          after: sanitizeUserForAudit(user),
          diff: computeDiff(null, sanitizeUserForAudit(user)),
          employeeIds: [user.employeeId],
          metadata: { ...versions, accessChanges: ['created'] },
        });
        if (user.isActive) {
          await writeAuthorizationChanged(tx, command, 'users.create', user, ['created'], versions);
        }

        return user;
      } catch (error) {
        throw mapUniqueViolation(error);
      }
    });
  }

  async updateUser(command: UpdateUserCommand): Promise<UserDto> {
    return this.runCommand(command, this.idempotencySpec('users.update', command), async (tx, versionBefore) => {
      // Locked until the audit is written: a concurrent relink cannot slip between the pre-image and the
      // update, so the audited «before» employee is the one this command really replaced. NO KEY UPDATE keeps
      // the audit FK key-share of other commands of this user (e.g. a contacts save by him) unblocked.
      const before = await this.lockTarget(tx, command);
      const assignments: string[] = [];
      const params: unknown[] = [];

      if ('username' in command.dto) {
        assignments.push(`username = $${params.push(command.dto.username)}`);
      }
      if ('email' in command.dto) {
        assignments.push(`email = $${params.push(normalizeEmail(command.dto.email, undefined))}`);
      }
      if ('role' in command.dto && command.dto.role) {
        assignments.push(`role_id = $${params.push(mapRoleToRoleId(command.dto.role))}`);
      }
      if ('employeeId' in command.dto) {
        assignments.push(`employee_id = $${params.push(command.dto.employeeId ?? null)}`);
      }
      if ('fullName' in command.dto) {
        assignments.push(`full_name = $${params.push(normalizeNullable(command.dto.fullName))}`);
      }
      if ('isActive' in command.dto) {
        assignments.push(`is_active = $${params.push(command.dto.isActive)}`);
      }

      assignments.push(`edited_by = $${params.push(toNullableUserId(command.currentUser.id))}`);
      assignments.push('row_version = u.row_version + 1');
      const userIdIndex = params.push(command.userId);
      const expectedRoleIndex = params.push(expectedRoleId(command.expectedTargetRole));

      try {
        const updated = await tx.query<UserRow>(
          `
          UPDATE users u
          SET ${assignments.join(', ')}
          WHERE u.user_id = $${userIdIndex}
            AND u.is_service_account = false
            AND ($${expectedRoleIndex}::smallint IS NULL OR u.role_id = $${expectedRoleIndex}::smallint)
          RETURNING
            u.user_id, u.username, u.email, u.full_name, u.role_id,
            (SELECT role_code FROM roles WHERE role_id = u.role_id) AS role_code,
            u.employee_id, u.is_active, u.created_at, u.updated_at, u.row_version
          `,
          params,
        );

        if (!updated.rows[0]) {
          throw await missingOrRoleChanged(tx, command.userId, command.expectedTargetRole);
        }

        // The account as it will be committed (e.g. a new role) may not exceed the administrator (0A.4).
        await assertNoAccountEscalation(tx, command.currentUser.id, command.userId);
        const changes: AuthorizationChange[] = [];
        if (before.role !== normalizeRole(updated.rows[0].role_id, updated.rows[0].role_code ?? null)) changes.push('role');
        if (before.isActive !== updated.rows[0].is_active) changes.push('activity');
        // Disabling through PATCH is the same as /deactivate: the sessions and the current token stop working.
        const revokedSessions = before.isActive && !updated.rows[0].is_active
          ? await revokeActiveSessions(tx, command.userId)
          : 0;
        const versions = await this.finishAuthorizationChange(tx, versionBefore, changes);
        const user = await this.mapUserRow(updated.rows[0], tx);
        await writeUserAudit(tx, {
          command,
          action: 'users.update',
          entityId: user.id,
          after: sanitizeUserForAudit(user),
          diff: computeDiff(sanitizeUserForAudit(before), sanitizeUserForAudit(user)),
          employeeIds: [before.employeeId, user.employeeId],
          metadata: { ...versions, accessChanges: changes, ...(revokedSessions ? { revokedSessions } : {}) },
        });
        if (changes.length > 0) {
          await writeAuthorizationChanged(tx, command, 'users.update', user, changes, versions);
        }

        return user;
      } catch (error) {
        throw mapUniqueViolation(error);
      }
    });
  }

  async changePassword(command: ChangeUserPasswordCommand) {
    const passwordHash = await bcrypt.hash(command.dto.newPassword, PASSWORD_HASH_ROUNDS);

    return this.runCommand(command, this.idempotencySpec('users.change_password', command), async (tx, versionBefore) => {
      await this.lockTarget(tx, command);
      const updated = await tx.query(
        `
        UPDATE users
        SET password_hash = $1, edited_by = $2, row_version = row_version + 1
        WHERE user_id = $3
          AND is_service_account = false
          AND ($4::smallint IS NULL OR role_id = $4::smallint)
        RETURNING user_id, row_version
        `,
        [passwordHash, toNullableUserId(command.currentUser.id), command.userId, expectedRoleId(command.expectedTargetRole)],
      );

      if (!updated.rows[0]) {
        throw await missingOrRoleChanged(tx, command.userId, command.expectedTargetRole);
      }
      // Resetting the password of an account with wider permissions than the administrator is an escalation.
      await assertNoAccountEscalation(tx, command.currentUser.id, command.userId);

      const revokedSessions = command.dto.revokeExistingSessions
        ? await revokeActiveSessions(tx, command.userId)
        : 0;

      await writeUserAudit(tx, {
        command,
        action: 'users.change_password',
        entityId: command.userId,
        diff: { credentialChanged: { from: false, to: true } },
        metadata: { revokedSessions, permissionsVersionBefore: versionBefore, permissionsVersionAfter: versionBefore },
      });

      // The new row version lets an open form keep saving without a false stale-version conflict.
      return { success: true as const, revokedSessions, rowVersion: toNumber((updated.rows[0] as { row_version: string | number }).row_version) };
    });
  }

  async deactivateUser(command: UserActivationCommand): Promise<UserDto> {
    return this.setActive(command, false, 'users.deactivate');
  }

  async activateUser(command: UserActivationCommand): Promise<UserDto> {
    return this.setActive(command, true, 'users.activate');
  }

  private async setActive(
    command: UserActivationCommand,
    isActive: boolean,
    action: 'users.deactivate' | 'users.activate',
  ): Promise<UserDto> {
    return this.runCommand(command, this.idempotencySpec(action, command), async (tx, versionBefore) => {
      const before = await this.lockTarget(tx, command);
      const updated = await tx.query<UserRow>(
        `
        UPDATE users u
        SET is_active = $1, edited_by = $2, row_version = u.row_version + 1
        WHERE u.user_id = $3
          AND u.is_service_account = false
          AND ($4::smallint IS NULL OR u.role_id = $4::smallint)
        RETURNING
          u.user_id, u.username, u.email, u.full_name, u.role_id,
          (SELECT role_code FROM roles WHERE role_id = u.role_id) AS role_code,
          u.employee_id, u.is_active, u.created_at, u.updated_at, u.row_version
        `,
        [isActive, toNullableUserId(command.currentUser.id), command.userId, expectedRoleId(command.expectedTargetRole)],
      );

      if (!updated.rows[0]) {
        throw await missingOrRoleChanged(tx, command.userId, command.expectedTargetRole);
      }

      // Re-enabling or disabling an account with wider permissions than the administrator is an escalation.
      await assertNoAccountEscalation(tx, command.currentUser.id, command.userId);
      const changes: AuthorizationChange[] = before.isActive !== isActive ? ['activity'] : [];
      const revokedSessions = isActive ? 0 : await revokeActiveSessions(tx, command.userId);
      const versions = await this.finishAuthorizationChange(tx, versionBefore, changes);
      const user = await this.mapUserRow(updated.rows[0], tx);

      await writeUserAudit(tx, {
        command,
        action,
        entityId: user.id,
        after: sanitizeUserForAudit(user),
        diff: computeDiff(sanitizeUserForAudit(before), sanitizeUserForAudit(user)),
        metadata: { revokedSessions, ...versions, accessChanges: changes },
      });
      if (changes.length > 0) {
        await writeAuthorizationChanged(tx, command, action, user, changes, versions);
      }

      return user;
    });
  }

  /**
   * Authorization command protocol (access groups plan §5.1, §5.3): permissions_state is locked first; then the
   * Idempotency-Key is claimed (a completed repeat returns the stored response before any version check, without new
   * state, version, audit or outbox); the command runs; its response is stored in the same transaction.
   */
  private async runCommand<T>(
    command: { currentUser: CurrentUser },
    spec: IdempotencySpec | null,
    body: (tx: TransactionClient, versionBefore: number) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const versionBefore = await lockAuthorizationState(tx, 'update');
      const key = spec?.key ?? null;
      if (spec) {
        const replay = await claimIdempotency<T>(tx, spec);
        if (replay !== null) return replay;
      }
      const result = await body(tx, versionBefore);
      if (key) {
        await tx.query(
          `UPDATE command_idempotency_keys SET status = 'completed', response_json = $2::jsonb, completed_at = now()
           WHERE idempotency_key = $1`,
          [key, JSON.stringify(result)],
        );
      }
      return result;
    });
  }

  /**
   * Steps 2–3 of §5.1 for a command over an existing user: the target row is locked, the actor is re-read in this
   * transaction and the command's policy re-run on fresh data, then the client's row version is compared.
   */
  private async lockTarget(
    tx: TransactionClient,
    command: { currentUser: CurrentUser; userId: number; expectedVersion?: number; recheck?: UserCommandRecheck },
  ): Promise<UserDto> {
    const before = await this.getUserByIdInternal(tx, command.userId, { lock: true });
    if (!before) throw userNotFound(command.userId);
    await this.recheckActor(tx, command, before);
    if (command.expectedVersion !== undefined && command.expectedVersion !== before.rowVersion) {
      throw new ApiError(409, 'USER_VERSION_CONFLICT', 'Пользователь изменён другим администратором, обновите форму', {
        userId: command.userId,
        expectedVersion: command.expectedVersion,
        currentVersion: before.rowVersion,
      });
    }
    return before;
  }

  private async recheckActor(
    tx: TransactionClient,
    command: { currentUser: CurrentUser; recheck?: UserCommandRecheck },
    target: UserDto | null,
  ): Promise<void> {
    if (!command.recheck) return;
    const actor = await loadEvaluationUserWith(tx, command.currentUser.id);
    const reason = actor
      ? command.recheck(actor, target ? { id: String(target.id), role: target.role } : null)
      : 'missing_permission';
    if (reason) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', { reason });
    }
  }

  /** Steps 5–6 of §5.1: lockout on the resulting state, then the authorization version (tokens refresh at once). */
  private async finishAuthorizationChange(
    tx: TransactionClient,
    versionBefore: number,
    changes: readonly AuthorizationChange[],
  ): Promise<{ permissionsVersionBefore: number; permissionsVersionAfter: number }> {
    if (changes.length === 0) {
      return { permissionsVersionBefore: versionBefore, permissionsVersionAfter: versionBefore };
    }
    await assertAdministrationRemains(tx);
    return { permissionsVersionBefore: versionBefore, permissionsVersionAfter: await bumpAuthorizationVersion(tx) };
  }

  private async getUserByIdInternal(database: DatabaseClient, userId: number, options: { lock?: boolean } = {}): Promise<UserDto | null> {
    const result = await database.query<UserRow>(
      `
      SELECT
        u.user_id, u.username, u.email, u.full_name, u.role_id, r.role_code,
        u.employee_id, u.is_active, u.created_at, u.updated_at, u.row_version
      FROM users u
      LEFT JOIN roles r ON r.role_id = u.role_id
      WHERE u.user_id = $1
        AND u.is_service_account = false
      ${options.lock ? 'FOR NO KEY UPDATE OF u' : ''}
      `,
      [userId],
    );

    // Same connection as the caller: inside a command transaction no seed and no second pool connection.
    return result.rows[0] ? this.mapUserRow(result.rows[0], database) : null;
  }

  private async mapUserRows(rows: readonly UserRow[]): Promise<UserDto[]> {
    return Promise.all(rows.map((row) => this.mapUserRow(row)));
  }

  private async mapUserRow(row: UserRow, client?: DatabaseClient): Promise<UserDto> {
    const role = normalizeRole(row.role_id, row.role_code);
    const roleId = toNumber(row.role_id);
    // Effective permissions of the user (base role; access groups when enabled), same source as the token.
    const permissions = this.permissions
      ? (await this.permissions.loadUserAuthorization(String(row.user_id), client))?.permissions ?? []
      : getPermissionsForRole(role);

    return {
      id: toNumber(row.user_id),
      username: row.username,
      email: row.email,
      fullName: row.full_name,
      role,
      permissions,
      employeeId: toNullableNumber(row.employee_id),
      isActive: row.is_active,
      createdAt: toIsoString(row.created_at),
      updatedAt: row.updated_at ? toIsoString(row.updated_at) : null,
      rowVersion: toNumber(row.row_version),
    };
  }
}

function buildListWhere(command: ListUsersCommand, params: unknown[]): string {
  const predicates: string[] = ['u.is_service_account = false'];

  if (command.query.search) {
    const index = params.push(`%${command.query.search}%`);
    predicates.push(`(u.username ILIKE $${index} OR u.email ILIKE $${index} OR u.full_name ILIKE $${index})`);
  }

  if (command.query.role) {
    const index = params.push(mapRoleToRoleId(command.query.role));
    predicates.push(`u.role_id = $${index}`);
  }

  if (command.query.isActive !== undefined) {
    const index = params.push(command.query.isActive);
    predicates.push(`u.is_active = $${index}`);
  }

  return `WHERE ${predicates.join(' AND ')}`;
}

function normalizeRole(roleIdValue: string | number, roleCode: string | null): UserRole {
  if (isUserRole(roleCode)) {
    return roleCode;
  }

  const roleId = toNumber(roleIdValue);
  const role = mapRoleIdToRole(roleId);
  if (!role) {
    throw new ApiError(500, 'UNKNOWN_ROLE', 'User role is not supported by backend', { roleId });
  }

  return role;
}

function normalizeEmail(email: string | null | undefined, username: string | undefined): string | null {
  const normalized = normalizeNullable(email);
  if (normalized !== null || !username) {
    return normalized;
  }

  return `${username}@local.erp.invalid`;
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function toNullableUserId(value: string): number | null {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  return toNumber(value);
}

function toNumber(value: string | number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ApiError(500, 'INVALID_DATABASE_VALUE', 'Database numeric value is invalid');
  }

  return numeric;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function revokeActiveSessions(tx: TransactionClient, userId: number): Promise<number> {
  const result = await tx.query<RevokedSessionsRow>(
    `
    WITH revoked_sessions AS (
      UPDATE auth_sessions
      SET status = 'revoked', revoked_at = now(), revoke_reason = 'user_management'
      WHERE user_id = $1 AND status = 'active'
      RETURNING session_id
    ),
    revoked_tokens AS (
      UPDATE refresh_tokens
      SET revoked_at = now(), revoked_reason = 'user_management'
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING token_id
    )
    SELECT COUNT(*)::int AS revoked_sessions FROM revoked_sessions
    `,
    [userId],
  );

  return toNumber(result.rows[0]?.revoked_sessions ?? 0);
}

async function writeUserAudit(
  tx: TransactionClient,
  input: {
    command:
      | CreateUserCommand
      | UpdateUserCommand
      | ChangeUserPasswordCommand
      | UserActivationCommand;
    action: string;
    entityId: string | number;
    after?: Record<string, unknown>;
    diff?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    /** Employees linked to the user before and after the change (normalized audit links). */
    employeeIds?: Array<number | null | undefined>;
  },
): Promise<void> {
  const employees = [...new Set((input.employeeIds ?? []).filter((id): id is number => typeof id === 'number' && Number.isFinite(id)))];
  await auditService.record(tx, {
    event: input.action,
    entityType: 'user',
    entityId: input.entityId,
    actorUserId: toNullableUserId(input.command.currentUser.id),
    actorUsername: input.command.currentUser.username,
    actorRole: input.command.currentUser.role,
    requestId: input.command.requestId ?? DEFAULT_REQUEST_ID,
    source: 'backend-users-command',
    after: input.after ?? null,
    diff: input.diff ?? null,
    metadata: input.metadata ?? null,
    ...(employees.length ? { relatedEntities: employees.map((entityId) => ({ entityType: 'employee', entityId })) } : {}),
  });
}

function sanitizeUserForAudit(user: UserDto): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    employeeId: user.employeeId,
    isActive: user.isActive,
  };
}

function expectedRoleId(role: UserRole | undefined): number | null {
  return role === undefined ? null : mapRoleToRoleId(role);
}

/** No row matched the mutation: the user is gone, or his role is no longer the one the policy decided on. */
async function missingOrRoleChanged(tx: DatabaseClient, userId: number, expectedRole: UserRole | undefined): Promise<ApiError> {
  if (expectedRole !== undefined) {
    const current = await tx.query<{ role_id: number | string }>(
      'SELECT role_id FROM users WHERE user_id = $1 AND is_service_account = false',
      [userId],
    );
    if (current.rows[0] && Number(current.rows[0].role_id) !== mapRoleToRoleId(expectedRole)) {
      return new ApiError(409, 'USER_ROLE_CHANGED', 'Роль пользователя изменилась, повторите действие', { userId });
    }
  }
  return userNotFound(userId);
}

/** Messages raised by trg_users_onec_operator_role_guard (migration 245). */
const ONEC_OPERATOR_ROLE_ERRORS: Record<string, string> = {
  ONEC_OPERATOR_ROLE_TRANSITION: 'Роль «Оператор интеграции 1С» назначается только при создании пользователя и не меняется',
  ONEC_OPERATOR_ROLE_DISABLED: 'Роль «Оператор интеграции 1С» отключена',
};

function mapUniqueViolation(error: unknown): never {
  const raised = typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P0001'
    ? String((error as { message?: unknown }).message ?? '')
    : '';
  for (const [code, message] of Object.entries(ONEC_OPERATOR_ROLE_ERRORS)) {
    if (raised.startsWith(code)) throw new ApiError(409, code, message);
  }
  if (isPgUniqueViolation(error)) {
    const constraint = String(error.constraint ?? '');
    if (constraint.includes('email')) {
      throw new UserAlreadyExistsError('email');
    }

    throw new UserAlreadyExistsError('username');
  }

  throw error;
}

function isPgUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function userNotFound(userId: number): ApiError {
  return new ApiError(404, 'USER_NOT_FOUND', 'User not found', { userId });
}

type AuthorizationChange = 'created' | 'role' | 'activity';

function requestHash(name: string, entityId: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ name, entityId, payload: sortKeys(payload) })).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

interface IdempotencySpec {
  name: UserCommandName;
  key: string;
  entityId: string;
  actorUserId: number | null;
  hash: string;
}

type UserCommandInput = CreateUserCommand | UpdateUserCommand | ChangeUserPasswordCommand | UserActivationCommand;

function assertSameRequest(
  row: { request_hash: string; actor_user_id: string | number | null },
  spec: IdempotencySpec,
): void {
  const storedActor = row.actor_user_id === null ? null : Number(row.actor_user_id);
  if (row.request_hash !== spec.hash || storedActor !== spec.actorUserId) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request');
  }
}

/** Same pattern as the other command repositories: insert the key or read the earlier attempt. */
async function claimIdempotency<T>(tx: TransactionClient, spec: IdempotencySpec): Promise<T | null> {
  const inserted = await tx.query(
    `INSERT INTO command_idempotency_keys
       (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
     VALUES ($1, $2, $3, 'user', $4, $5, 'processing') ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [spec.key, spec.name, spec.actorUserId, spec.entityId, spec.hash],
  );
  if (inserted.rowCount === 1) return null;
  const existing = await tx.query<{ request_hash: string; response_json: T | null; status: string; actor_user_id: string | number | null }>(
    'SELECT request_hash, response_json, status, actor_user_id FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE',
    [spec.key],
  );
  const row = existing.rows[0];
  if (!row) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request');
  assertSameRequest(row, spec);
  if (row.status === 'completed' && row.response_json) return row.response_json;
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

/**
 * Domain event of an authorization change (plan §7), in the command transaction. Delivery is not enabled in v1:
 * the relay marks a type without consumers processed. The key is unique per committed change of the user
 * (row_version grows with every command), so a replay — which never reaches here — cannot duplicate it.
 */
async function writeAuthorizationChanged(
  tx: TransactionClient,
  command: { currentUser: CurrentUser; requestId?: string },
  action: string,
  user: UserDto,
  changes: readonly AuthorizationChange[],
  versions: { permissionsVersionBefore: number; permissionsVersionAfter: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ('authorization.changed', 'user', $1, $2::jsonb, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      String(user.id),
      JSON.stringify({
        command: action,
        actorUserId: toNullableUserId(command.currentUser.id),
        requestId: command.requestId ?? DEFAULT_REQUEST_ID,
        affectedUserIds: [user.id],
        changes,
        role: user.role,
        isActive: user.isActive,
        ...versions,
      }),
      `authorization.changed:user-${user.id}:row-${user.rowVersion}`,
    ],
  );
}
