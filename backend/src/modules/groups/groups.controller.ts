import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import type {
  CreateGroupRequestDto,
  GroupListQuery,
  GroupListResponseDto,
  GroupLookupResponseDto,
  GroupMembersResponseDto,
  GroupResponseDto,
  GroupStatus,
  ReplaceGroupMembersRequestDto,
  UpdateGroupRequestDto,
} from './dto/group.dto';
import { GroupsRuntimeConfigService } from './groups-runtime-config.service';
import { GroupsService, type GroupLookupQuery } from './groups.service';

const GROUP_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
const GROUP_MUTABLE_STATUSES = ['draft', 'active', 'paused', 'completed'] as const;
const groupStatusSchema = z.enum(GROUP_STATUSES);
const groupMutableStatusSchema = z.enum(GROUP_MUTABLE_STATUSES);
const uuidSchema = z.string().uuid();
const groupCodeSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/);
const groupNameSchema = z.string().trim().min(1).max(256);
const groupDateSchema = z
  .string()
  .refine(isValidGroupDate, 'Invalid group date')
  .nullable();
const groupMetadataSchema = z.record(z.string(), z.unknown());
const groupMemberRoleSchema = z.string().trim().min(1).max(100);
const groupMemberInputSchema = z.object({
  userId: z.number().int().positive(),
  role: groupMemberRoleSchema,
  metadata: groupMetadataSchema.optional(),
});
const replaceGroupMembersPayloadSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    members: z.array(groupMemberInputSchema).max(500),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, member] of value.members.entries()) {
      const key = `${member.userId}:${member.role}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', index],
          message: 'Duplicate user/role member',
        });
      }
      seen.add(key);
    }
  });
const groupPayloadSchema = z
  .object({
    code: groupCodeSchema,
    name: groupNameSchema,
    description: z.string().trim().max(2000).nullable().optional(),
    status: groupMutableStatusSchema.default('active'),
    startsAt: groupDateSchema.optional(),
    endsAt: groupDateSchema.optional(),
    ownerUserId: z.number().int().positive().nullable().optional(),
    metadata: groupMetadataSchema.optional(),
  })
  .refine(hasValidDateRange, {
    path: ['endsAt'],
    message: 'endsAt must be on or after startsAt',
  });
const updateGroupPayloadSchema = z
  .object({
    code: groupCodeSchema.optional(),
    name: groupNameSchema.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: groupMutableStatusSchema.optional(),
    startsAt: groupDateSchema.optional(),
    endsAt: groupDateSchema.optional(),
    ownerUserId: z.number().int().positive().nullable().optional(),
    metadata: groupMetadataSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  })
  .refine(hasValidDateRange, {
    path: ['endsAt'],
    message: 'endsAt must be on or after startsAt',
  });
const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const groupSwaggerSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'status', 'ownerUserId', 'metadata', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    status: { type: 'string', enum: GROUP_STATUSES },
    startsAt: { type: 'string', format: 'date', nullable: true },
    endsAt: { type: 'string', format: 'date', nullable: true },
    ownerUserId: { type: 'integer', nullable: true },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    archivedAt: { type: 'string', format: 'date-time', nullable: true },
    createdBy: { type: 'integer', nullable: true },
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

const groupListResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: groupSwaggerSchema },
    pagination: paginationSwaggerSchema,
  },
} as const;

const groupLookupResponseSwaggerSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'code', 'name', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          code: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: GROUP_STATUSES },
        },
      },
    },
  },
} as const;

const groupMemberSwaggerSchema = {
  type: 'object',
  required: ['id', 'userId', 'username', 'employeeId', 'displayName', 'role', 'validFrom', 'metadata'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'integer', minimum: 1 },
    username: { type: 'string' },
    employeeId: { type: 'integer', nullable: true },
    displayName: { type: 'string', nullable: true },
    role: { type: 'string' },
    validFrom: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const groupMembersResponseSwaggerSchema = {
  type: 'object',
  required: ['groupId', 'members', 'requestId'],
  properties: {
    groupId: { type: 'string', format: 'uuid' },
    members: { type: 'array', items: groupMemberSwaggerSchema },
    requestId: { type: 'string' },
    changed: { type: 'boolean' },
    auditId: { type: 'string' },
  },
} as const;

const groupResponseSwaggerSchema = {
  type: 'object',
  required: ['group'],
  properties: {
    group: groupSwaggerSchema,
  },
} as const;

const createGroupRequestSwaggerSchema = {
  type: 'object',
  required: ['code', 'name'],
  properties: {
    code: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 256 },
    description: { type: 'string', maxLength: 2000, nullable: true },
    status: { type: 'string', enum: GROUP_MUTABLE_STATUSES, default: 'active' },
    startsAt: { type: 'string', format: 'date', nullable: true },
    endsAt: { type: 'string', format: 'date', nullable: true },
    ownerUserId: { type: 'integer', minimum: 1, nullable: true },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const updateGroupRequestSwaggerSchema = {
  type: 'object',
  minProperties: 1,
  properties: createGroupRequestSwaggerSchema.properties,
} as const;

const replaceGroupMembersRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey', 'members'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    members: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['userId', 'role'],
        properties: {
          userId: { type: 'integer', minimum: 1 },
          role: { type: 'string', minLength: 1, maxLength: 100 },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    },
    reason: { type: 'string', maxLength: 500, nullable: true },
  },
} as const;

@ApiTags('Groups')
@ApiBearerAuth()
@Controller('groups')
export class GroupsController {
  constructor(
    @Inject(GroupsService)
    private readonly groups: GroupsService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search code or name' })
  @ApiQuery({ name: 'status', required: false, enum: GROUP_STATUSES, description: 'Group status' })
  @ApiQuery({ name: 'ownerUserId', required: false, type: Number, description: 'Owner user id' })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean, description: 'Include archived groups' })
  @ApiResponse({ status: 200, description: 'Group list', schema: swaggerSchema(groupListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid group list query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'listGroups', summary: 'List groups' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupListResponseDto> {
    this.assertGroupsEnabled();

    return this.groups.list({
      currentUser: this.requireCurrentUser(request),
      query: parseGroupListQuery(query),
      requestId: request.requestId,
    });
  }

  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search code or name' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum lookup items' })
  @ApiResponse({ status: 200, description: 'Group lookup', schema: swaggerSchema(groupLookupResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid group lookup query' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'lookupGroups', summary: 'Lookup groups' })
  @Get('lookup')
  async lookup(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<GroupLookupResponseDto> {
    this.assertGroupsEnabled();

    return this.groups.lookup({
      currentUser: this.requireCurrentUser(request),
      query: parseGroupLookupQuery(query),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiResponse({ status: 200, description: 'Group', schema: swaggerSchema(groupResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'getGroupById', summary: 'Get a group by ID' })
  @Get(':groupId')
  async getById(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
  ): Promise<GroupResponseDto> {
    this.assertGroupsEnabled();

    const group = await this.groups.getById({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      requestId: request.requestId,
    });

    return { group };
  }

  @ApiBody({ schema: swaggerSchema(createGroupRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created group', schema: swaggerSchema(groupResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid create group payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({ operationId: 'createGroup', summary: 'Create a group' })
  @Post()
  async create(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<GroupResponseDto> {
    this.assertGroupWritesEnabled();

    const group = await this.groups.create({
      currentUser: this.requireCurrentUser(request),
      dto: parseCreateGroupRequest(body),
      requestId: request.requestId,
    });

    return { group };
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiBody({ schema: swaggerSchema(updateGroupRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Updated group', schema: swaggerSchema(groupResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  @ApiResponse({ status: 422, description: 'Invalid update group payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({ operationId: 'updateGroup', summary: 'Update a group' })
  @Patch(':groupId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Body() body: unknown,
  ): Promise<GroupResponseDto> {
    this.assertGroupWritesEnabled();

    const group = await this.groups.update({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      dto: parseUpdateGroupRequest(body),
      requestId: request.requestId,
    });

    return { group };
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiResponse({ status: 200, description: 'Archived group', schema: swaggerSchema(groupResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({ operationId: 'archiveGroup', summary: 'Archive a group' })
  @Delete(':groupId')
  @HttpCode(200)
  async archive(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
  ): Promise<GroupResponseDto> {
    this.assertGroupWritesEnabled();

    const group = await this.groups.archive({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      requestId: request.requestId,
    });

    return { group };
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiResponse({ status: 200, description: 'Current group members', schema: swaggerSchema(groupMembersResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({
    operationId: 'listGroupMembers',
    summary: 'List current group members',
    description: 'Compatibility endpoint for user-only group_members. Prefer /groups/{groupId}/participants for typed user/employee participants.',
  })
  @Get(':groupId/members')
  async listMembers(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
  ): Promise<GroupMembersResponseDto> {
    this.assertGroupsEnabled();

    return this.groups.listMembers({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiBody({ schema: swaggerSchema(replaceGroupMembersRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced current group members', schema: swaggerSchema(groupMembersResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid group members payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({
    operationId: 'replaceGroupMembers',
    summary: 'Replace current group members',
    description: 'Compatibility endpoint for user-only group_members. Prefer /groups/{groupId}/participants for typed user/employee participants.',
  })
  @Put(':groupId/members')
  @HttpCode(200)
  async replaceMembers(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Body() body: unknown,
  ): Promise<GroupMembersResponseDto> {
    this.assertGroupWritesEnabled();

    return this.groups.replaceMembers({
      currentUser: this.requireCurrentUser(request),
      groupId: parseGroupId(groupIdParam),
      dto: parseReplaceGroupMembersRequest(body),
      requestId: request.requestId,
    });
  }

  private assertGroupsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }
  }

  private assertGroupWritesEnabled(): void {
    this.assertGroupsEnabled();

    if (this.runtimeConfig.getFeatureFlags().groupsReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is read-only', {
        feature: 'groups',
        readOnly: true,
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

export function parseGroupListQuery(
  query: Record<string, string | string[] | undefined>,
): GroupListQuery {
  return {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 25, 1, 200),
    search: parseSearch(query.search),
    status: parseGroupStatus(query.status),
    ownerUserId: parseOptionalPositiveInteger(query.ownerUserId, 'ownerUserId'),
    includeArchived: parseOptionalBoolean(query.includeArchived, 'includeArchived'),
  };
}

export function parseGroupLookupQuery(
  query: Record<string, string | string[] | undefined>,
): GroupLookupQuery {
  return {
    search: parseSearch(query.search),
    limit: parsePositiveInteger(query.limit, 'limit', 20, 1, 100),
  };
}

export function parseGroupId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid group id', { field: 'groupId' });
  }

  return parsed.data;
}

export function parseCreateGroupRequest(body: unknown): CreateGroupRequestDto {
  return parseRequestBody(groupPayloadSchema, body) as CreateGroupRequestDto;
}

export function parseUpdateGroupRequest(body: unknown): UpdateGroupRequestDto {
  return parseRequestBody(updateGroupPayloadSchema, body) as UpdateGroupRequestDto;
}

export function parseReplaceGroupMembersRequest(body: unknown): ReplaceGroupMembersRequestDto {
  return parseRequestBody(replaceGroupMembersPayloadSchema, body) as ReplaceGroupMembersRequestDto;
}

function parseSearch(value: string | string[] | undefined): string | undefined {
  const search = singleValue(value)?.trim();
  if (!search) return undefined;

  if (search.length > 200) {
    throw validationError('search', 'search must be 200 characters or fewer');
  }

  return search;
}

function parseGroupStatus(value: string | string[] | undefined): GroupStatus | undefined {
  const raw = singleValue(value);
  if (!raw) return undefined;

  const parsed = groupStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError('status', 'Unsupported group status', { allowedValues: [...GROUP_STATUSES] });
  }

  return parsed.data;
}

function parseOptionalPositiveInteger(
  value: string | string[] | undefined,
  field: string,
): number | undefined {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return undefined;

  return parsePositiveInteger(raw, field, undefined, 1, Number.MAX_SAFE_INTEGER);
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

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(
  field: string,
  message: string,
  extraDetails: Record<string, unknown> = {},
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Group query validation failed', {
    errors: [{ field, message }],
    ...extraDetails,
  });
}

function parseRequestBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Group request validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

function hasValidDateRange(value: { startsAt?: string | null; endsAt?: string | null }): boolean {
  if (!value.startsAt || !value.endsAt) return true;
  return value.endsAt >= value.startsAt;
}

function isValidGroupDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
