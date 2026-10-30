import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import { parseIdempotencyKey } from '../authorization-idempotency';
import type { CurrentUser, RequestWithCurrentUser } from '../current-user';
import { PermissionsService } from '../permissions.service';
import type {
  AccessGroupDto,
  AccessGroupsListDto,
  UserAuthorizationSourcesDto,
} from './access-groups.types';
import { PgAccessGroupsRepository, type AccessGroupsCommandContext } from './pg-access-groups.repository';

const version = z.number().int().positive();
const createSchema = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
}).strict();
const updateSchema = z.object({
  version,
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();
const permissionsSchema = z.object({
  version,
  permissions: z.array(z.string().min(1).max(120)).max(500),
  scopes: z.record(z.string(), z.array(z.string()).max(3)),
  confirmDangerous: z.boolean().optional(),
}).strict();
const membersSchema = z.object({ version, userIds: z.array(z.number().int().positive()).max(1000) }).strict();
const deleteSchema = z.object({ version }).strict();
const settingsSchema = z.object({ enabled: z.boolean(), version }).strict();
const userGroupsSchema = z.object({ rowVersion: version, groupIds: z.array(z.number().int().positive()).max(200) }).strict();

const idempotencyHeader = {
  name: 'Idempotency-Key',
  required: true,
  description: 'One key per action; a repeat with the same key and payload returns the stored response',
  schema: { type: 'string', minLength: 8, maxLength: 200 },
} as const;

/**
 * «Конфигурация → Права ролей → Группы доступа» (access groups plan R7 §4.2). Reading: permissions.manage or
 * system.superadmin; changing: both (as the roles matrix), checked again inside the command on fresh data.
 */
@ApiTags('Permissions')
@ApiBearerAuth()
@Controller('permissions/access-groups')
export class AccessGroupsController {
  constructor(
    @Inject(PgAccessGroupsRepository) private readonly groups: PgAccessGroupsRepository,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  @ApiOperation({ operationId: 'listAccessGroups', summary: 'Access groups and the switch' })
  @ApiResponse({ status: 200, description: 'Groups' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser): Promise<AccessGroupsListDto> {
    requireReader(this.permissions, request);
    return this.groups.list();
  }

  @ApiOperation({ operationId: 'updateAccessGroupsSettings', summary: 'Turn access groups on or off' })
  @ApiHeader(idempotencyHeader)
  @ApiResponse({ status: 409, description: 'PERMISSIONS_VERSION_CONFLICT, PERMISSIONS_LOCKOUT_DENIED, ACCESS_GROUPS_HASURA_NOT_CLOSED' })
  @Put('settings')
  async settings(@Req() request: RequestWithCurrentUser, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<AccessGroupsListDto> {
    return this.groups.updateSettings(commandContext(this.permissions, request, key), parse(settingsSchema, body));
  }

  @ApiOperation({ operationId: 'getAccessGroup', summary: 'One access group with permissions, scopes and members' })
  @ApiParam({ name: 'groupId', type: Number })
  @Get(':groupId')
  async get(@Req() request: RequestWithCurrentUser, @Param('groupId') groupId: string): Promise<AccessGroupDto> {
    requireReader(this.permissions, request);
    return this.groups.get(parseId(groupId));
  }

  @ApiOperation({ operationId: 'createAccessGroup', summary: 'Create an access group (no permissions, no members)' })
  @ApiHeader(idempotencyHeader)
  @Post()
  @HttpCode(201)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<AccessGroupDto> {
    return this.groups.create(commandContext(this.permissions, request, key), parse(createSchema, body));
  }

  @ApiOperation({ operationId: 'updateAccessGroup', summary: 'Rename, describe, activate or deactivate a group' })
  @ApiHeader(idempotencyHeader)
  @ApiParam({ name: 'groupId', type: Number })
  @Patch(':groupId')
  async update(@Req() request: RequestWithCurrentUser, @Param('groupId') groupId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<AccessGroupDto> {
    return this.groups.update(commandContext(this.permissions, request, key), parseId(groupId), parse(updateSchema, body));
  }

  @ApiOperation({ operationId: 'replaceAccessGroupPermissions', summary: 'Permissions and scope sets of a group' })
  @ApiHeader(idempotencyHeader)
  @ApiParam({ name: 'groupId', type: Number })
  @ApiResponse({ status: 422, description: 'DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED, INVALID_SCOPE_VALUE, PERMISSION_NARROWING_BLOCKED' })
  @Put(':groupId/permissions')
  async permissionsOf(@Req() request: RequestWithCurrentUser, @Param('groupId') groupId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<AccessGroupDto> {
    return this.groups.replacePermissions(commandContext(this.permissions, request, key), parseId(groupId), parse(permissionsSchema, body));
  }

  @ApiOperation({ operationId: 'replaceAccessGroupMembers', summary: 'Members of a group' })
  @ApiHeader(idempotencyHeader)
  @ApiParam({ name: 'groupId', type: Number })
  @Put(':groupId/members')
  async members(@Req() request: RequestWithCurrentUser, @Param('groupId') groupId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<AccessGroupDto> {
    return this.groups.replaceMembers(commandContext(this.permissions, request, key), parseId(groupId), parse(membersSchema, body));
  }

  @ApiOperation({ operationId: 'deleteAccessGroup', summary: 'Delete an inactive group without members' })
  @ApiHeader(idempotencyHeader)
  @ApiParam({ name: 'groupId', type: Number })
  @Delete(':groupId')
  async remove(@Req() request: RequestWithCurrentUser, @Param('groupId') groupId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<{ groupId: number; deleted: true }> {
    return this.groups.remove(commandContext(this.permissions, request, key), parseId(groupId), parse(deleteSchema, body));
  }
}

/** Access groups of one user and his effective authorization with sources (the user card). */
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UserAccessGroupsController {
  constructor(
    @Inject(PgAccessGroupsRepository) private readonly groups: PgAccessGroupsRepository,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  @ApiOperation({ operationId: 'getUserAuthorizationSources', summary: 'Effective permissions and scopes of a user with their sources' })
  @ApiParam({ name: 'userId', type: Number })
  @Get(':userId/authorization')
  async authorization(@Req() request: RequestWithCurrentUser, @Param('userId') userId: string): Promise<UserAuthorizationSourcesDto> {
    requireReader(this.permissions, request);
    return this.groups.userAuthorization(parseId(userId));
  }

  @ApiOperation({ operationId: 'replaceUserAccessGroups', summary: 'Access groups of a user (users.row_version)' })
  @ApiHeader(idempotencyHeader)
  @ApiParam({ name: 'userId', type: Number })
  @ApiResponse({ status: 409, description: 'USER_VERSION_CONFLICT, PERMISSIONS_LOCKOUT_DENIED' })
  @Put(':userId/access-groups')
  async replace(@Req() request: RequestWithCurrentUser, @Param('userId') userId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string | string[]): Promise<UserAuthorizationSourcesDto> {
    return this.groups.replaceUserGroups(commandContext(this.permissions, request, key), parseId(userId), parse(userGroupsSchema, body));
  }
}

function currentUserOf(request: RequestWithCurrentUser): CurrentUser {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function requireReader(permissions: PermissionsService, request: RequestWithCurrentUser): void {
  const user = currentUserOf(request);
  if (!permissions.canUser(user, 'permissions.manage') && !permissions.canUser(user, 'system.superadmin')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', { requiredPermissions: ['permissions.manage'] });
  }
}

function commandContext(permissions: PermissionsService, request: RequestWithCurrentUser, header: string | string[] | undefined): AccessGroupsCommandContext {
  const user = currentUserOf(request);
  if (!permissions.canUser(user, 'system.superadmin') || !permissions.canUser(user, 'permissions.manage')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: ['system.superadmin', 'permissions.manage'],
    });
  }
  const key = parseIdempotencyKey(header, true)!;
  return { currentUser: user, requestId: request.requestId ?? 'access-groups', idempotencyKey: key };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid request', { errors: parsed.error.issues });
  return parsed.data;
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid id');
  return id;
}
