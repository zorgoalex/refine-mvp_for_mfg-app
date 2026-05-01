import type { PermissionName, UserRole } from '../../../permissions/permissions';

export interface PaginationDto {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UserDto {
  id: number;
  username: string;
  email?: string | null;
  fullName?: string | null;
  role: UserRole;
  permissions: readonly PermissionName[];
  employeeId?: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string | null;
}

export interface UserListResponseDto {
  data: UserDto[];
  pagination: PaginationDto;
}

export interface UserResponseDto {
  user: UserDto;
}

export interface CreateUserRequestDto {
  username: string;
  email?: string | null;
  password: string;
  role: UserRole;
  employeeId?: number | null;
  fullName?: string | null;
  isActive?: boolean;
}

export interface UpdateUserRequestDto {
  username?: string;
  email?: string | null;
  role?: UserRole;
  employeeId?: number | null;
  fullName?: string | null;
  isActive?: boolean;
}

export interface ChangePasswordRequestDto {
  newPassword: string;
  revokeExistingSessions?: boolean;
}

export interface ChangePasswordResponseDto {
  success: true;
  revokedSessions: number;
}
