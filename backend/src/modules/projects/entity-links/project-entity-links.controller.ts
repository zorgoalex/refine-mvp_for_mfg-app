import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { parseProjectId } from '../projects.controller';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseAppendProjectEntityLinksRequest,
  parseReplaceProjectEntityLinksRequest,
  PROJECT_ENTITY_TYPE_CODES,
  type ProjectEntityLinksResponseDto,
  type ProjectEntityTypeCode,
} from './project-entity-links.dto';
import { ProjectEntityLinksService } from './project-entity-links.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;
const entityTypeSchema = z.enum(PROJECT_ENTITY_TYPE_CODES);

const projectEntityLinksResponseSwaggerSchema = {
  type: 'object',
  required: ['projectId', 'links', 'requestId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', format: 'uuid' },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'entityType', 'entityId', 'displayLabel', 'relationType', 'validFrom', 'validTo', 'metadata'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          entityType: { type: 'string', enum: PROJECT_ENTITY_TYPE_CODES },
          entityId: { type: 'string' },
          displayLabel: { type: 'string', nullable: true },
          relationType: { type: 'string' },
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

const projectEntityLinksRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey', 'links'],
  additionalProperties: false,
  properties: {
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    links: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['entityType', 'entityId'],
        additionalProperties: false,
        properties: {
          entityType: { type: 'string', enum: PROJECT_ENTITY_TYPE_CODES },
          entityId: { type: 'string', minLength: 1, maxLength: 200 },
          relationType: { type: 'string', default: 'related' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    },
    reason: { type: 'string', maxLength: 500, nullable: true },
  },
} as const;

@ApiTags('Projects')
@ApiBearerAuth('bearerAuth')
@Controller('projects/:projectId/entity-links')
export class ProjectEntityLinksController {
  constructor(
    @Inject(ProjectEntityLinksService)
    private readonly links: ProjectEntityLinksService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiQuery({ name: 'entityType', required: false, enum: PROJECT_ENTITY_TYPE_CODES })
  @ApiQuery({ name: 'includeClosed', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Project entity links', schema: swaggerSchema(projectEntityLinksResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'listProjectEntityLinks', summary: 'List project entity links' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectEntityLinksResponseDto> {
    this.assertProjectsEnabled();
    const currentUser = this.requireCurrentUser(request);
    const entityType = parseEntityType(query.entityType);
    return this.links.list({
      currentUser,
      projectId: parseProjectId(projectIdParam),
      entityType,
      includeClosed: parseBoolean(query.includeClosed),
      visibleEntityTypes: entityType ? undefined : this.links.visibleEntityTypes(currentUser),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiBody({ schema: swaggerSchema(projectEntityLinksRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced project entity links', schema: swaggerSchema(projectEntityLinksResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled or read-only' })
  @ApiOperation({ operationId: 'replaceProjectEntityLinks', summary: 'Replace current project entity links' })
  @Put()
  @HttpCode(200)
  async replace(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
    @Body() body: unknown,
  ): Promise<ProjectEntityLinksResponseDto> {
    this.assertProjectWritesEnabled();
    return this.links.replace({
      currentUser: this.requireCurrentUser(request),
      projectId: parseProjectId(projectIdParam),
      dto: parseReplaceProjectEntityLinksRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiBody({ schema: swaggerSchema(projectEntityLinksRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Appended project entity links', schema: swaggerSchema(projectEntityLinksResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled or read-only' })
  @ApiOperation({ operationId: 'appendProjectEntityLinks', summary: 'Append project entity links' })
  @Post()
  async append(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
    @Body() body: unknown,
  ): Promise<ProjectEntityLinksResponseDto> {
    this.assertProjectWritesEnabled();
    return this.links.append({
      currentUser: this.requireCurrentUser(request),
      projectId: parseProjectId(projectIdParam),
      dto: parseAppendProjectEntityLinksRequest(body),
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

function parseEntityType(value: string | string[] | undefined): ProjectEntityTypeCode | undefined {
  const raw = single(value);
  if (!raw) return undefined;
  const parsed = entityTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid entityType', { field: 'entityType' });
  }
  return parsed.data;
}

function parseBoolean(value: string | string[] | undefined): boolean | undefined {
  const raw = single(value);
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ApiError(422, 'VALIDATION_ERROR', 'includeClosed must be true or false', { field: 'includeClosed' });
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
