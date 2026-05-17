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
};

const ROLE_ID_TO_NAME: Record<number, UserRole> = {
  1: 'admin',
  2: 'superadmin',
  10: 'manager',
  11: 'operator',
  15: 'top_manager',
  20: 'worker',
  100: 'viewer',
};

const ROLE_NAME_TO_ID: Record<string, number> = {
  admin: 1,
  superadmin: 2,
  manager: 10,
  operator: 11,
  top_manager: 15,
  worker: 20,
  viewer: 100,
};

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
  };
}

export function mapBackendUpdateUserRequest(
  values: UserFormValues,
): UpdateUserRequest {
  return {
    username: values.username,
    email: nullableText(values.email),
    role: values.role,
    fullName: nullableText(values.full_name),
    isActive: values.is_active,
  };
}

export function mapLegacyUserFormToHasuraPayload(
  values: UserFormValues,
): Record<string, unknown> {
  const { role, ...rest } = values;

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
