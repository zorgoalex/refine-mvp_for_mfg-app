import { Body, Controller, Get, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { parseProjectId } from '../projects.controller';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseReplaceProjectParticipantsRequest,
  PROJECT_PARTICIPANT_TYPES,
  type ProjectParticipantRoleListResponseDto,
  type ProjectParticipantsResponseDto,
} from './project-participants.dto';
import { ProjectParticipantsService } from './project-participants.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const projectParticipantsResponseSwaggerSchema = {
  type: 'object',
  required: ['projectId', 'participants', 'requestId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', format: 'uuid' },
    participants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'participantType', 'participantId', 'displayName', 'role', 'validFrom', 'validTo', 'metadata'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          participantType: { type: 'string', enum: PROJECT_PARTICIPANT_TYPES },
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

const projectParticipantsRequestSwaggerSchema = {
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
          participantType: { type: 'string', enum: PROJECT_PARTICIPANT_TYPES },
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

@ApiTags('Projects')
@ApiBearerAuth('bearerAuth')
@Controller('projects')
export class ProjectParticipantsController {
  constructor(
    @Inject(ProjectParticipantsService)
    private readonly participants: ProjectParticipantsService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
    @Inject(PermissionsService)
    private readonly permissions: PermissionsService,
  ) {}

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiResponse({ status: 200, description: 'Project participants', schema: swaggerSchema(projectParticipantsResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'listProjectParticipants', summary: 'List typed project participants' })
  @Get(':projectId/participants')
  async list(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
  ): Promise<ProjectParticipantsResponseDto> {
    this.assertProjectsEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.participants.list({
      currentUser,
      projectId: parseProjectId(projectIdParam),
      canViewUsers: this.permissions.canUser(currentUser, 'users.view'),
      canViewEmployees: this.permissions.canUser(currentUser, 'employees.view'),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiBody({ schema: swaggerSchema(projectParticipantsRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced project participants', schema: swaggerSchema(projectParticipantsResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled or read-only' })
  @ApiOperation({ operationId: 'replaceProjectParticipants', summary: 'Replace typed project participants' })
  @Put(':projectId/participants')
  @HttpCode(200)
  async replace(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
    @Body() body: unknown,
  ): Promise<ProjectParticipantsResponseDto> {
    this.assertProjectWritesEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.participants.replace({
      currentUser,
      projectId: parseProjectId(projectIdParam),
      dto: parseReplaceProjectParticipantsRequest(body),
      canViewUsers: this.permissions.canUser(currentUser, 'users.view'),
      canViewEmployees: this.permissions.canUser(currentUser, 'employees.view'),
      requestId: request.requestId,
    });
  }

  @ApiResponse({ status: 200, description: 'Project participant roles', schema: swaggerSchema(participantRolesResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'listProjectParticipantRoles', summary: 'List project participant roles' })
  @Get('participant-roles')
  async roles(@Req() request: RequestWithCurrentUser): Promise<ProjectParticipantRoleListResponseDto> {
    this.assertProjectsEnabled();
    return this.participants.roles({
      currentUser: this.requireCurrentUser(request),
      requestId: request.requestId,
    });
  }

  private assertProjectsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', { feature: 'projects' });
    }
  }

  private assertProjectWritesEnabled(): void {
    this.assertProjectsEnabled();
    if (this.runtimeConfig.getFeatureFlags().projectsReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is read-only', {
        feature: 'projects',
        readOnly: true,
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
