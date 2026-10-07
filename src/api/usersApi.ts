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

  // One Idempotency-Key per user action: a repeat of the same request returns the stored result.
  create(request: CreateUserRequest, idempotencyKey: string = newActionKey()): Promise<UserResponse> {
    return httpClient.post<UserResponse>(apiRoutes.users.list, request, actionHeaders(idempotencyKey));
  },

  update(userId: number, request: UpdateUserRequest, idempotencyKey: string = newActionKey()): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(
      apiRoutes.users.byId(validateUserId(userId)),
      request,
      actionHeaders(idempotencyKey),
    );
  },

  changePassword(
    userId: number,
    request: ChangePasswordRequest,
    idempotencyKey: string = newActionKey(),
  ): Promise<ChangePasswordResponse> {
    return httpClient.post<ChangePasswordResponse>(
      apiRoutes.users.changePassword(validateUserId(userId)),
      request,
      actionHeaders(idempotencyKey),
    );
  },

  deactivate(userId: number, expectedVersion?: number, idempotencyKey: string = newActionKey()): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(
      apiRoutes.users.deactivate(validateUserId(userId)),
      expectedVersion === undefined ? undefined : { expectedVersion },
      actionHeaders(idempotencyKey),
    );
  },

  activate(userId: number, expectedVersion?: number, idempotencyKey: string = newActionKey()): Promise<UserResponse> {
    return httpClient.patch<UserResponse>(
      apiRoutes.users.activate(validateUserId(userId)),
      expectedVersion === undefined ? undefined : { expectedVersion },
      actionHeaders(idempotencyKey),
    );
  },
};

export function validateUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error('Invalid userId');
  }

  return userId;
}

function newActionKey(): string {
  return `users-${crypto.randomUUID()}`;
}

function actionHeaders(idempotencyKey: string) {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}
