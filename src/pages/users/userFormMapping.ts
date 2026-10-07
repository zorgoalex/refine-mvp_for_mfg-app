import type { UserRole } from '../../api/types/authApi.types';
import type {
  CreateUserRequest,
  UpdateUserRequest,
} from '../../api/types/userApi.types';

type UserFormValues = {
  username?: string;
  email?: string | null;
  password?: string;
  role?: UserRole;
  full_name?: string | null;
  is_active?: boolean;
  /** The linked employee; null unlinks, undefined leaves it as is. */
  employee_id?: number | null;
};

const ROLE_ID_TO_NAME: Record<number, UserRole> = {
  1: 'admin',
  2: 'superadmin',
  10: 'manager',
  11: 'operator',
  15: 'top_manager',
  20: 'worker',
  30: 'packer',
  32: 'onec_operator',
  100: 'viewer',
};

const ROLE_NAME_TO_ID: Record<string, number> = {
  admin: 1,
  superadmin: 2,
  manager: 10,
  operator: 11,
  top_manager: 15,
  worker: 20,
  packer: 30,
  viewer: 100,
  onec_operator: 32,
};

/**
 * Roles assigned only when the user is created: the backend (and a database trigger) refuse to switch an existing
 * user to or from them, so the edit form locks the role field for such accounts and does not offer the role to others.
 */
export const CREATION_ONLY_ROLES: readonly UserRole[] = ['onec_operator'];

export function isCreationOnlyRole(role: UserRole | null | undefined): boolean {
  return typeof role === 'string' && CREATION_ONLY_ROLES.includes(role);
}

export function mapUserRecordToFormData<T extends Record<string, any>>(
  data: T,
): T & { role?: UserRole } {
  return {
    ...data,
    role:
      typeof data.role === 'string'
        ? data.role
        : typeof data.role_id === 'number'
          ? ROLE_ID_TO_NAME[data.role_id]
          : undefined,
  };
}

export function mapBackendCreateUserRequest(
  values: UserFormValues,
): CreateUserRequest {
  return {
    username: requiredText(values.username, 'username'),
    email: nullableText(values.email),
    password: requiredPassword(values.password),
    role: requiredRole(values.role),
    fullName: nullableText(values.full_name),
    isActive: values.is_active ?? true,
    ...(values.employee_id !== undefined ? { employeeId: values.employee_id } : {}),
  };
}

export function mapBackendUpdateUserRequest(
  values: UserFormValues,
  expectedVersion?: number | null,
): UpdateUserRequest {
  return {
    ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
    username: values.username,
    email: nullableText(values.email),
    role: values.role,
    fullName: nullableText(values.full_name),
    isActive: values.is_active,
    ...(values.employee_id !== undefined ? { employeeId: values.employee_id } : {}),
  };
}

export function mapLegacyUserFormToHasuraPayload(
  values: UserFormValues,
): Record<string, unknown> {
  // The employee link is changed only by the backend users command (audited with both employees).
  const { role, employee_id: _employeeId, ...rest } = values;

  return {
    ...rest,
    role_id: role ? ROLE_NAME_TO_ID[role] : undefined,
  };
}

function requiredText(value: string | null | undefined, field: string): string {
  const normalized = nullableText(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  return normalized;
}

function requiredPassword(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    throw new Error('password is required');
  }

  return value;
}

function requiredRole(value: UserRole | undefined): UserRole {
  if (!value) {
    throw new Error('role is required');
  }

  return value;
}

function nullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}
