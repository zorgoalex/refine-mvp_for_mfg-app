import type { PermissionName, UserRole } from './authApi.types';

export interface UserDto {
  id: number;
  username: string;
  email?: string | null;
  fullName?: string | null;
  role: UserRole;
  permissions: PermissionName[];
  employeeId?: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string | null;
}

export interface UserListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: UserRole;
  isActive?: boolean;
}

export interface UserListResponse {
  data: UserDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface UserResponse {
  user: UserDto;
}

export interface CreateUserRequest {
  username: string;
  email?: string | null;
  password: string;
  role: UserRole;
  employeeId?: number | null;
  fullName?: string | null;
  isActive?: boolean;
}

export interface UpdateUserRequest {
  username?: string;
  email?: string | null;
  role?: UserRole;
  employeeId?: number | null;
  fullName?: string | null;
  isActive?: boolean;
}

export interface ChangePasswordRequest {
  newPassword: string;
  revokeExistingSessions?: boolean;
}

export interface ChangePasswordResponse {
  success: true;
  revokedSessions: number;
}
