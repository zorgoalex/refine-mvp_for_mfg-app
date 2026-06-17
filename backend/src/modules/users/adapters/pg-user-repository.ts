import bcrypt from 'bcryptjs';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import { computeDiff } from '../../../common/audit/audit-diff';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import {
  getPermissionsForRole,
  isUserRole,
  mapRoleIdToRole,
  mapRoleToRoleId,
} from '../../../permissions/permissions';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
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
  constructor(private readonly database: UserDatabase | DatabaseService) {}

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
      data: usersResult.rows.map(mapUserRow),
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
        const user = mapUserRow(created.rows[0]);

        await writeUserAudit(tx, {
          command,
          action: 'users.create',
          entityId: user.id,
          after: sanitizeUserForAudit(user),
          diff: computeDiff(null, sanitizeUserForAudit(user)),
        });

        return user;
      } catch (error) {
        throw mapUniqueViolation(error);
      }
    });
  }

  async updateUser(command: UpdateUserCommand): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.getUserByIdInternal(tx, command.userId);
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

      try {
        const updated = await tx.query<UserRow>(
          `
          UPDATE users u
          SET ${assignments.join(', ')}
          WHERE u.user_id = $${userIdIndex}
          RETURNING
            u.user_id, u.username, u.email, u.full_name, u.role_id,
            (SELECT role_code FROM roles WHERE role_id = u.role_id) AS role_code,
            u.employee_id, u.is_active, u.created_at, u.updated_at
          `,
          params,
        );

        if (!updated.rows[0]) {
          throw userNotFound(command.userId);
        }

        const user = mapUserRow(updated.rows[0]);
        await writeUserAudit(tx, {
          command,
          action: 'users.update',
          entityId: user.id,
          after: sanitizeUserForAudit(user),
          diff: computeDiff(before ? sanitizeUserForAudit(before) : null, sanitizeUserForAudit(user)),
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
        RETURNING user_id
        `,
        [passwordHash, toNullableUserId(command.currentUser.id), command.userId],
      );

      if (!updated.rows[0]) {
        throw userNotFound(command.userId);
      }

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
      const before = await this.getUserByIdInternal(tx, command.userId);
      const updated = await tx.query<UserRow>(
        `
        UPDATE users u
        SET is_active = $1, edited_by = $2
        WHERE u.user_id = $3
        RETURNING
          u.user_id, u.username, u.email, u.full_name, u.role_id,
          (SELECT role_code FROM roles WHERE role_id = u.role_id) AS role_code,
          u.employee_id, u.is_active, u.created_at, u.updated_at
        `,
        [isActive, toNullableUserId(command.currentUser.id), command.userId],
      );

      if (!updated.rows[0]) {
        throw userNotFound(command.userId);
      }

      const revokedSessions = isActive ? 0 : await revokeActiveSessions(tx, command.userId);
      const user = mapUserRow(updated.rows[0]);

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

  private async getUserByIdInternal(database: DatabaseClient, userId: number): Promise<UserDto | null> {
    const result = await database.query<UserRow>(
      `
      SELECT
        u.user_id, u.username, u.email, u.full_name, u.role_id, r.role_code,
        u.employee_id, u.is_active, u.created_at, u.updated_at
      FROM users u
      LEFT JOIN roles r ON r.role_id = u.role_id
      WHERE u.user_id = $1
      `,
      [userId],
    );

    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }
}

function buildListWhere(command: ListUsersCommand, params: unknown[]): string {
  const predicates: string[] = [];

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

  return predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
}

function mapUserRow(row: UserRow): UserDto {
  const role = normalizeRole(row.role_id, row.role_code);

  return {
    id: toNumber(row.user_id),
    username: row.username,
    email: row.email,
    fullName: row.full_name,
    role,
    permissions: getPermissionsForRole(role),
    employeeId: toNullableNumber(row.employee_id),
    isActive: row.is_active,
    createdAt: toIsoString(row.created_at),
    updatedAt: row.updated_at ? toIsoString(row.updated_at) : null,
  };
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
  },
): Promise<void> {
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

function mapUniqueViolation(error: unknown): never {
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
