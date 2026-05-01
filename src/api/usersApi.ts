import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  CreateUserRequest,
  UpdateUserRequest,
  UserDto,
  UserListQuery,
  UserListResponse,
  UserResponse,
} from './types/userApi.types';

export const usersApi = {
  list(params: UserListQuery = {}): Promise<UserListResponse> {
    return httpClient.get<UserListResponse>(withQuery('/api/users', params));
  },

  async getById(userId: number): Promise<UserDto> {
    const response = await httpClient.get<UserResponse>(`/api/users/${validateUserId(userId)}`);
    return response.user;
  },

  create(request: CreateUserRequest): Promise<UserResponse> {
    return httpClient.post<UserResponse>('/api/users', request);
  },

  update(userId: number, request: UpdateUserRequest): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(`/api/users/${validateUserId(userId)}`, request);
  },

  changePassword(
    userId: number,
    request: ChangePasswordRequest,
  ): Promise<ChangePasswordResponse> {
    return httpClient.post<ChangePasswordResponse>(
      `/api/users/${validateUserId(userId)}/change-password`,
      request,
    );
  },

  deactivate(userId: number): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(`/api/users/${validateUserId(userId)}/deactivate`);
  },

  activate(userId: number): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(`/api/users/${validateUserId(userId)}/activate`);
  },
};

export function validateUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error('Invalid userId');
  }

  return userId;
}
