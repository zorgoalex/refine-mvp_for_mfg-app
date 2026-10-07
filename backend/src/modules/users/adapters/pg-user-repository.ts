import bcrypt from 'bcryptjs';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { DatabaseService } from '../../../database/database.service';
import { assertNoAccountEscalation } from '../../../permissions/account-escalation';
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
  ) {}

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
        u.employee_id, u.is_active, u.created_at, u.updated_at
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

    return this.database.transaction(async (tx) => {
      try {
        await lockAuthorizationState(tx);
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
            employee_id, is_active, created_at, updated_at
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

        await writeUserAudit(tx, {
          command,
          action: 'users.create',
          entityId: user.id,
          after: sanitizeUserForAudit(user),
          diff: computeDiff(null, sanitizeUserForAudit(user)),
          employeeIds: [user.employeeId],
        });

        return user;
      } catch (error) {
        throw mapUniqueViolation(error);
      }
    });
  }

  async updateUser(command: UpdateUserCommand): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      // Authorization lock order (access groups plan §5.1): permissions_state first, then the user row.
      await lockAuthorizationState(tx);
      // Locked until the audit is written: a concurrent relink cannot slip between the pre-image and the
      // update, so the audited «before» employee is the one this command really replaced. NO KEY UPDATE keeps
      // the audit FK key-share of other commands of this user (e.g. a contacts save by him) unblocked.
      const before = await this.getUserByIdInternal(tx, command.userId, { lock: true });
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
            u.employee_id, u.is_active, u.created_at, u.updated_at
          `,
          params,
        );

        if (!updated.rows[0]) {
          throw await missingOrRoleChanged(tx, command.userId, command.expectedTargetRole);
        }

        // The account as it will be committed (e.g. a new role) may not exceed the administrator (0A.4).
        await assertNoAccountEscalation(tx, command.currentUser.id, command.userId);
        await bumpUserVersions(tx, command.userId,
          before !== null && before.role !== normalizeRole(updated.rows[0].role_id, updated.rows[0].role_code ?? null));
        const user = await this.mapUserRow(updated.rows[0], tx);
        await writeUserAudit(tx, {
          command,
          action: 'users.update',
          entityId: user.id,
          after: sanitizeUserForAudit(user),
          diff: computeDiff(before ? sanitizeUserForAudit(before) : null, sanitizeUserForAudit(user)),
          employeeIds: [before?.employeeId, user.employeeId],
        });

        return user;
      } catch (error) {
        throw mapUniqueViolation(error);
      }
    });
  }

  async changePassword(command: ChangeUserPasswordCommand) {
    const passwordHash = await bcrypt.hash(command.dto.newPassword, PASSWORD_HASH_ROUNDS);

    return this.database.transaction(async (tx) => {
      const updated = await tx.query(
        `
        UPDATE users
        SET password_hash = $1, edited_by = $2
        WHERE user_id = $3
          AND is_service_account = false
          AND ($4::smallint IS NULL OR role_id = $4::smallint)
        RETURNING user_id
        `,
        [passwordHash, toNullableUserId(command.currentUser.id), command.userId, expectedRoleId(command.expectedTargetRole)],
      );

      if (!updated.rows[0]) {
        throw await missingOrRoleChanged(tx, command.userId, command.expectedTargetRole);
      }
      // Resetting the password of an account with wider permissions than the administrator is an escalation.
      await assertNoAccountEscalation(tx, command.currentUser.id, command.userId);
      await bumpUserVersions(tx, command.userId, false);

      const revokedSessions = command.dto.revokeExistingSessions
        ? await revokeActiveSessions(tx, command.userId)
        : 0;

      await writeUserAudit(tx, {
        command,
        action: 'users.change_password',
        entityId: command.userId,
        diff: { credentialChanged: { from: false, to: true } },
        metadata: { revokedSessions },
      });

      return { success: true as const, revokedSessions };
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
    return this.database.transaction(async (tx) => {
      // Authorization lock order (access groups plan §5.1): permissions_state first, then the user row.
      await lockAuthorizationState(tx);
      const before = await this.getUserByIdInternal(tx, command.userId);
      const updated = await tx.query<UserRow>(
        `
        UPDATE users u
        SET is_active = $1, edited_by = $2
        WHERE u.user_id = $3
          AND u.is_service_account = false
          AND ($4::smallint IS NULL OR u.role_id = $4::smallint)
        RETURNING
          u.user_id, u.username, u.email, u.full_name, u.role_id,
          (SELECT role_code FROM roles WHERE role_id = u.role_id) AS role_code,
          u.employee_id, u.is_active, u.created_at, u.updated_at
        `,
        [isActive, toNullableUserId(command.currentUser.id), command.userId, expectedRoleId(command.expectedTargetRole)],
      );

      if (!updated.rows[0]) {
        throw await missingOrRoleChanged(tx, command.userId, command.expectedTargetRole);
      }

      // Re-enabling or disabling an account with wider permissions than the administrator is an escalation.
      await assertNoAccountEscalation(tx, command.currentUser.id, command.userId);
      await bumpUserVersions(tx, command.userId, before?.isActive !== isActive);
      const revokedSessions = isActive ? 0 : await revokeActiveSessions(tx, command.userId);
      const user = await this.mapUserRow(updated.rows[0], tx);

      await writeUserAudit(tx, {
        command,
        action,
        entityId: user.id,
        after: sanitizeUserForAudit(user),
        diff: computeDiff(before ? sanitizeUserForAudit(before) : null, sanitizeUserForAudit(user)),
        metadata: { revokedSessions },
      });

      return user;
    });
  }

  private async getUserByIdInternal(database: DatabaseClient, userId: number, options: { lock?: boolean } = {}): Promise<UserDto | null> {
    const result = await database.query<UserRow>(
      `
      SELECT
        u.user_id, u.username, u.email, u.full_name, u.role_id, r.role_code,
        u.employee_id, u.is_active, u.created_at, u.updated_at
      FROM users u
      LEFT JOIN roles r ON r.role_id = u.role_id
      WHERE u.user_id = $1
        AND u.is_service_account = false
      ${options.lock ? 'FOR NO KEY UPDATE OF u' : ''}
      `,
      [userId],
    );

    return result.rows[0] ? this.mapUserRow(result.rows[0]) : null;
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

/** Authorization lock order (access groups plan §5.1): permissions_state is always locked before user rows. */
async function lockAuthorizationState(tx: TransactionClient): Promise<void> {
  await tx.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
}

/**
 * Every user command increments users.row_version (stale-write protection, plan §5.3). A change of role or
 * activity also increments the authorization version, so the user's current token stops being accepted at once
 * (the token is refreshed with the new grants) instead of living until its natural refresh (plan 0A.7).
 */
async function bumpUserVersions(tx: TransactionClient, userId: number | string, authorizationChanged: boolean): Promise<void> {
  await tx.query('UPDATE users SET row_version = row_version + 1 WHERE user_id = $1', [userId]);
  if (authorizationChanged) {
    await tx.query('UPDATE permissions_state SET version = version + 1, updated_at = now() WHERE id = true');
  }
}
