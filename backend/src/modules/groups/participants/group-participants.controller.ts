import { Body, Controller, Get, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { parseGroupId } from '../groups.controller';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseReplaceGroupParticipantsRequest,
  GROUP_PARTICIPANT_TYPES,
  type GroupParticipantRoleListResponseDto,
  type GroupParticipantsResponseDto,
} from './group-participants.dto';
import { GroupParticipantsService } from './group-participants.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const groupParticipantsResponseSwaggerSchema = {
  type: 'object',
  required: ['groupId', 'participants', 'requestId'],
  additionalProperties: false,
  properties: {
    groupId: { type: 'string', format: 'uuid' },
    participants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'participantType', 'participantId', 'displayName', 'role', 'validFrom', 'validTo', 'metadata'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          participantType: { type: 'string', enum: GROUP_PARTICIPANT_TYPES },
          participantId: { type: 'string', nullable: true },
          displayName: { type: 'string', nullable: true },
          role: {
            type: 'object',
            required: ['code', 'label'],
            additionalProperties: false,
            properties: { code: { type: 'string' }, label: { type: 'string' } },
          },
          validFrom: { type: 'string', format: 'date-time' },
          validTo: { type: 'string', format: 'date-time', nullable: true },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    },
    requestId: { type: 'string' },
    changed: { type: 'boolean' },
    auditId: { type: 'string' },
  },
} as const;

const groupParticipantsRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey', 'participants'],
  additionalProperties: false,
  properties: {
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    participants: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['participantType', 'participantId', 'roleCode'],
        additionalProperties: false,
        properties: {
          participantType: { type: 'string', enum: GROUP_PARTICIPANT_TYPES },
          participantId: { type: 'string', minLength: 1, maxLength: 200 },
          roleCode: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    },
    reason: { type: 'string', maxLength: 500, nullable: true },
  },
} as const;

const participantRolesResponseSwaggerSchema = {
  type: 'object',
  required: ['roles', 'requestId'],
  additionalProperties: false,
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'label'],
        additionalProperties: false,
        properties: { code: { type: 'string' }, label: { type: 'string' } },
      },
    },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Groups')
@ApiBearerAuth('bearerAuth')
@Controller('groups')
export class GroupParticipantsController {
  constructor(
    @Inject(GroupParticipantsService)
    private readonly participants: GroupParticipantsService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
    @Inject(PermissionsService)
    private readonly permissions: PermissionsService,
  ) {}

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiResponse({ status: 200, description: 'Group participants', schema: swaggerSchema(groupParticipantsResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'listGroupParticipants', summary: 'List typed group participants' })
  @Get(':groupId/participants')
  async list(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
  ): Promise<GroupParticipantsResponseDto> {
    this.assertGroupsEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.participants.list({
      currentUser,
      groupId: parseGroupId(groupIdParam),
      canViewUsers: this.permissions.canUser(currentUser, 'users.view'),
      canViewEmployees: this.permissions.canUser(currentUser, 'employees.view'),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiBody({ schema: swaggerSchema(groupParticipantsRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced group participants', schema: swaggerSchema(groupParticipantsResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled or read-only' })
  @ApiOperation({ operationId: 'replaceGroupParticipants', summary: 'Replace typed group participants' })
  @Put(':groupId/participants')
  @HttpCode(200)
  async replace(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Body() body: unknown,
  ): Promise<GroupParticipantsResponseDto> {
    this.assertGroupWritesEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.participants.replace({
      currentUser,
      groupId: parseGroupId(groupIdParam),
      dto: parseReplaceGroupParticipantsRequest(body),
      canViewUsers: this.permissions.canUser(currentUser, 'users.view'),
      canViewEmployees: this.permissions.canUser(currentUser, 'employees.view'),
      requestId: request.requestId,
    });
  }

  @ApiResponse({ status: 200, description: 'Group participant roles', schema: swaggerSchema(participantRolesResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'listGroupParticipantRoles', summary: 'List group participant roles' })
  @Get('participant-roles')
  async roles(@Req() request: RequestWithCurrentUser): Promise<GroupParticipantRoleListResponseDto> {
    this.assertGroupsEnabled();
    return this.participants.roles({
      currentUser: this.requireCurrentUser(request),
      requestId: request.requestId,
    });
  }

  private assertGroupsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', { feature: 'groups' });
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
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
