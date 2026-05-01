import { apiRoutes } from './apiRoutes';
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
    return httpClient.get<UserListResponse>(withQuery(apiRoutes.users.list, params));
  },

  async getById(userId: number): Promise<UserDto> {
    const response = await httpClient.get<UserResponse>(
      apiRoutes.users.byId(validateUserId(userId)),
    );
    return response.user;
  },

  create(request: CreateUserRequest): Promise<UserResponse> {
    return httpClient.post<UserResponse>(apiRoutes.users.list, request);
  },

  update(userId: number, request: UpdateUserRequest): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(
      apiRoutes.users.byId(validateUserId(userId)),
      request,
    );
  },

  changePassword(
    userId: number,
    request: ChangePasswordRequest,
  ): Promise<ChangePasswordResponse> {
    return httpClient.post<ChangePasswordResponse>(
      apiRoutes.users.changePassword(validateUserId(userId)),
      request,
    );
  },

  deactivate(userId: number): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(apiRoutes.users.deactivate(validateUserId(userId)));
  },

  activate(userId: number): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(apiRoutes.users.activate(validateUserId(userId)));
  },
};

export function validateUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error('Invalid userId');
  }

  return userId;
}
