import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { USER_ROLES, type UserRole } from '../../../permissions/permissions';
import { UserService } from '../application/user.service';
import type { UserListQuery } from '../application/user-command.types';
import type {
  ChangePasswordRequestDto,
  CreateUserRequestDto,
  UpdateUserRequestDto,
  UserListResponseDto,
  UserResponseDto,
} from '../dto/user.dto';
import { UsersRuntimeConfigService } from './users-runtime-config.service';

const userRoleSchema = z.enum(USER_ROLES);
const nullableTextSchema = z.string().trim().max(255).nullable().optional();
const emailSchema = z.string().trim().email().nullable().optional();
const employeeIdSchema = z.number().int().positive().nullable().optional();

const createUserRequestSchema = z.object({
  username: z.string().trim().min(3).max(100),
  email: emailSchema,
  password: z.string().min(8).max(200),
  role: userRoleSchema,
  employeeId: employeeIdSchema,
  fullName: nullableTextSchema,
  isActive: z.boolean().optional(),
});

const updateUserRequestSchema = z
  .object({
    username: z.string().trim().min(3).max(100).optional(),
    email: emailSchema,
    role: userRoleSchema.optional(),
    employeeId: employeeIdSchema,
    fullName: nullableTextSchema,
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

const changePasswordRequestSchema = z.object({
  newPassword: z.string().min(8).max(200),
  revokeExistingSessions: z.boolean().default(true),
});

const userSwaggerSchema = {
  type: 'object',
  required: ['id', 'username', 'role', 'permissions', 'isActive', 'createdAt'],
  properties: {
    id: { type: 'integer' },
    username: { type: 'string' },
    email: { type: 'string', format: 'email', nullable: true },
    fullName: { type: 'string', nullable: true },
    role: { type: 'string', enum: USER_ROLES },
    permissions: { type: 'array', items: { type: 'string' } },
    employeeId: { type: 'integer', nullable: true },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const paginationSwaggerSchema = {
  type: 'object',
  required: ['page', 'pageSize', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
    totalPages: { type: 'integer' },
  },
} as const;

const createUserRequestSwaggerSchema = {
  type: 'object',
  required: ['username', 'password', 'role'],
  properties: {
    username: { type: 'string', minLength: 3, maxLength: 100 },
    email: { type: 'string', format: 'email', nullable: true },
    password: { type: 'string', minLength: 8, maxLength: 200, writeOnly: true },
    role: { type: 'string', enum: USER_ROLES },
    employeeId: { type: 'integer', nullable: true },
    fullName: { type: 'string', maxLength: 255, nullable: true },
    isActive: { type: 'boolean' },
  },
} as const;

const updateUserRequestSwaggerSchema = {
  type: 'object',
  minProperties: 1,
  properties: {
    username: { type: 'string', minLength: 3, maxLength: 100 },
    email: { type: 'string', format: 'email', nullable: true },
    role: { type: 'string', enum: USER_ROLES },
    employeeId: { type: 'integer', nullable: true },
    fullName: { type: 'string', maxLength: 255, nullable: true },
    isActive: { type: 'boolean' },
  },
} as const;

const changePasswordRequestSwaggerSchema = {
  type: 'object',
  required: ['newPassword'],
  properties: {
    newPassword: { type: 'string', minLength: 8, maxLength: 200, writeOnly: true },
    revokeExistingSessions: { type: 'boolean', default: true },
  },
} as const;

const userResponseSwaggerSchema = {
  type: 'object',
  required: ['user'],
  properties: {
    user: userSwaggerSchema,
  },
} as const;

const userListResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: userSwaggerSchema },
    pagination: paginationSwaggerSchema,
  },
} as const;

const changePasswordResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'revokedSessions'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    revokedSessions: { type: 'integer' },
  },
} as const;

@Controller('users')
export class UsersController {
  constructor(
    @Inject(UserService)
    private readonly users: UserService,
    @Inject(UsersRuntimeConfigService)
    private readonly runtimeConfig: UsersRuntimeConfigService,
  ) {}

  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<UserListResponseDto> {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.users.list({
      currentUser,
      query: parseUserListQuery(query),
      requestId: request.requestId,
    });
  }

  @Get(':userId')
  async getById(
    @Req() request: RequestWithCurrentUser,
    @Param('userId') userIdParam: string,
  ): Promise<UserResponseDto> {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    const user = await this.users.getById({
      currentUser,
      userId: parseUserId(userIdParam),
      requestId: request.requestId,
    });

    return { user };
  }

  @Post()
  async create(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<UserResponseDto> {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    const user = await this.users.create({
      currentUser,
      dto: parseCreateUserRequest(body),
      requestId: request.requestId,
    });

    return { user };
  }

  @Patch(':userId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('userId') userIdParam: string,
    @Body() body: unknown,
  ): Promise<UserResponseDto> {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    const user = await this.users.update({
      currentUser,
      userId: parseUserId(userIdParam),
      dto: parseUpdateUserRequest(body),
      requestId: request.requestId,
    });

    return { user };
  }

  @Post(':userId/change-password')
  @HttpCode(200)
  async changePassword(
    @Req() request: RequestWithCurrentUser,
    @Param('userId') userIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.users.changePassword({
      currentUser,
      userId: parseUserId(userIdParam),
      dto: parseChangePasswordRequest(body),
      requestId: request.requestId,
    });
  }

  @Patch(':userId/deactivate')
  async deactivate(
    @Req() request: RequestWithCurrentUser,
    @Param('userId') userIdParam: string,
  ): Promise<UserResponseDto> {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    const user = await this.users.deactivate({
      currentUser,
      userId: parseUserId(userIdParam),
      requestId: request.requestId,
    });

    return { user };
  }

  @Patch(':userId/activate')
  async activate(
    @Req() request: RequestWithCurrentUser,
    @Param('userId') userIdParam: string,
  ): Promise<UserResponseDto> {
    this.assertUsersEnabled();

    const currentUser = this.requireCurrentUser(request);
    const user = await this.users.activate({
      currentUser,
      userId: parseUserId(userIdParam),
      requestId: request.requestId,
    });

    return { user };
  }

  private assertUsersEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().usersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Users API is disabled', {
        feature: 'users',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

export function parseUserListQuery(
  query: Record<string, string | string[] | undefined>,
): UserListQuery {
  return {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 25, 1, 200),
    search: parseSearch(query.search),
    role: parseUserRole(query.role),
    isActive: parseOptionalBoolean(query.isActive, 'isActive'),
  };
}

export function parseUserId(value: string): number {
  const userId = Number(value);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid user id', {
      field: 'userId',
    });
  }

  return userId;
}

export function parseCreateUserRequest(body: unknown): CreateUserRequestDto {
  return parseRequestBody(createUserRequestSchema, body) as CreateUserRequestDto;
}

export function parseUpdateUserRequest(body: unknown): UpdateUserRequestDto {
  return parseRequestBody(updateUserRequestSchema, body) as UpdateUserRequestDto;
}

export function parseChangePasswordRequest(body: unknown): ChangePasswordRequestDto {
  return parseRequestBody(changePasswordRequestSchema, body) as ChangePasswordRequestDto;
}

function parseSearch(value: string | string[] | undefined): string | undefined {
  const search = singleValue(value)?.trim();
  if (!search) return undefined;

  if (search.length > 200) {
    throw validationError('search', 'search must be 200 characters or fewer');
  }

  return search;
}

function parseUserRole(value: string | string[] | undefined): UserRole | undefined {
  const role = singleValue(value);
  if (!role) return undefined;

  const parsed = userRoleSchema.safeParse(role);
  if (!parsed.success) {
    throw validationError('role', 'Unsupported user role', { allowedValues: [...USER_ROLES] });
  }

  return parsed.data;
}

function parseOptionalBoolean(
  value: string | string[] | undefined,
  field: string,
): boolean | undefined {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return undefined;

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  throw validationError(field, `${field} must be true or false`);
}

function parsePositiveInteger(
  value: string | string[] | undefined,
  field: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw validationError(field, `${field} is required`);
    }
    return fallback;
  }

  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw validationError(field, `${field} must be an integer between ${min} and ${max}`);
  }

  return numberValue;
}

function parseRequestBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'User request validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(
  field: string,
  message: string,
  extraDetails: Record<string, unknown> = {},
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'User query validation failed', {
    errors: [{ field, message }],
    ...extraDetails,
  });
}
