import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import type {
  ProjectListQuery,
  ProjectListResponseDto,
  ProjectLookupResponseDto,
  ProjectResponseDto,
  ProjectStatus,
} from './dto/project.dto';
import { ProjectsRuntimeConfigService } from './projects-runtime-config.service';
import { ProjectsService, type ProjectLookupQuery } from './projects.service';

const PROJECT_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
const projectStatusSchema = z.enum(PROJECT_STATUSES);
const uuidSchema = z.string().uuid();
const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const projectSwaggerSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'status', 'ownerUserId', 'metadata', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    status: { type: 'string', enum: PROJECT_STATUSES },
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

const projectListResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: projectSwaggerSchema },
    pagination: paginationSwaggerSchema,
  },
} as const;

const projectLookupResponseSwaggerSchema = {
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
          status: { type: 'string', enum: PROJECT_STATUSES },
        },
      },
    },
  },
} as const;

const projectResponseSwaggerSchema = {
  type: 'object',
  required: ['project'],
  properties: {
    project: projectSwaggerSchema,
  },
} as const;

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectsService)
    private readonly projects: ProjectsService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search code or name' })
  @ApiQuery({ name: 'status', required: false, enum: PROJECT_STATUSES, description: 'Project status' })
  @ApiQuery({ name: 'ownerUserId', required: false, type: Number, description: 'Owner user id' })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean, description: 'Include archived projects' })
  @ApiResponse({ status: 200, description: 'Project list', schema: swaggerSchema(projectListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid project list query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'listProjects', summary: 'List projects' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectListResponseDto> {
    this.assertProjectsEnabled();

    return this.projects.list({
      currentUser: this.requireCurrentUser(request),
      query: parseProjectListQuery(query),
      requestId: request.requestId,
    });
  }

  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search code or name' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum lookup items' })
  @ApiResponse({ status: 200, description: 'Project lookup', schema: swaggerSchema(projectLookupResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid project lookup query' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'lookupProjects', summary: 'Lookup projects' })
  @Get('lookup')
  async lookup(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ProjectLookupResponseDto> {
    this.assertProjectsEnabled();

    return this.projects.lookup({
      currentUser: this.requireCurrentUser(request),
      query: parseProjectLookupQuery(query),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiResponse({ status: 200, description: 'Project', schema: swaggerSchema(projectResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'getProjectById', summary: 'Get a project by ID' })
  @Get(':projectId')
  async getById(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
  ): Promise<ProjectResponseDto> {
    this.assertProjectsEnabled();

    const project = await this.projects.getById({
      currentUser: this.requireCurrentUser(request),
      projectId: parseProjectId(projectIdParam),
      requestId: request.requestId,
    });

    return { project };
  }

  private assertProjectsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
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

export function parseProjectListQuery(
  query: Record<string, string | string[] | undefined>,
): ProjectListQuery {
  return {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 25, 1, 200),
    search: parseSearch(query.search),
    status: parseProjectStatus(query.status),
    ownerUserId: parseOptionalPositiveInteger(query.ownerUserId, 'ownerUserId'),
    includeArchived: parseOptionalBoolean(query.includeArchived, 'includeArchived'),
  };
}

export function parseProjectLookupQuery(
  query: Record<string, string | string[] | undefined>,
): ProjectLookupQuery {
  return {
    search: parseSearch(query.search),
    limit: parsePositiveInteger(query.limit, 'limit', 20, 1, 100),
  };
}

export function parseProjectId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid project id', { field: 'projectId' });
  }

  return parsed.data;
}

function parseSearch(value: string | string[] | undefined): string | undefined {
  const search = singleValue(value)?.trim();
  if (!search) return undefined;

  if (search.length > 200) {
    throw validationError('search', 'search must be 200 characters or fewer');
  }

  return search;
}

function parseProjectStatus(value: string | string[] | undefined): ProjectStatus | undefined {
  const raw = singleValue(value);
  if (!raw) return undefined;

  const parsed = projectStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError('status', 'Unsupported project status', { allowedValues: [...PROJECT_STATUSES] });
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
  return new ApiError(422, 'VALIDATION_ERROR', 'Project query validation failed', {
    errors: [{ field, message }],
    ...extraDetails,
  });
}
