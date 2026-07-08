import { Body, Controller, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProjectsService } from '../application/projects.service';
import type { CreateProjectResult, MergeResult, ProjectCard, ProjectDto, UpdateProjectDtoBody } from '../application/projects.types';
import { createProjectSchema, listProjectsSchema, mergeSchema, updateProjectSchema } from '../dto/projects.dto';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const projectSwaggerSchema = {
  type: 'object',
  required: ['projectId', 'code', 'name', 'clientId', 'notes', 'version'],
  properties: {
    projectId: { type: 'integer' },
    code: { type: 'string' },
    name: { type: 'string' },
    clientId: { type: 'integer' },
    clientName: { type: 'string' },
    notes: { type: 'string', nullable: true },
    version: { type: 'integer' },
    ordersCount: { type: 'integer' },
    totalFinalAmount: { type: 'string' },
    totalPaidAmount: { type: 'string' },
  },
} as const;

const projectCardSwaggerSchema = {
  allOf: [
    projectSwaggerSchema,
    {
      type: 'object',
      required: ['orders'],
      properties: {
        orders: {
          type: 'array',
          items: {
            type: 'object',
            required: ['orderId', 'orderName', 'fullNumber', 'finalAmount', 'paidAmount', 'orderStatusName', 'deleteFlag'],
            properties: {
              orderId: { type: 'integer' },
              orderName: { type: 'string' },
              fullNumber: { type: 'string' },
              finalAmount: { type: 'string', nullable: true },
              paidAmount: { type: 'string', nullable: true },
              orderStatusName: { type: 'string', nullable: true },
              deleteFlag: { type: 'boolean' },
            },
          },
        },
      },
    },
  ],
} as const;

const updateProjectSwaggerSchema = {
  type: 'object',
  required: ['expectedVersion'],
  properties: {
    code: { type: 'string', pattern: '^[0-9A-Za-zА-Яа-яЁё-]{1,20}$' },
    name: { type: 'string', minLength: 1, maxLength: 300 },
    notes: { type: 'string', maxLength: 4000, nullable: true },
    expectedVersion: { type: 'integer', minimum: 0 },
  },
} as const;

const createProjectSwaggerSchema = {
  type: 'object',
  required: ['clientId', 'name', 'idempotencyKey'],
  properties: {
    clientId: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 300 },
    code: { type: 'string', pattern: '^[0-9A-Za-zА-Яа-яЁё-]{1,20}$' },
    notes: { type: 'string', maxLength: 4000, nullable: true },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const createProjectResponseSwaggerSchema = {
  allOf: [
    projectSwaggerSchema,
    {
      type: 'object',
      required: ['auditId', 'requestId'],
      properties: {
        auditId: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
  ],
} as const;

const mergeProjectSwaggerSchema = {
  type: 'object',
  required: ['sourceProjectId', 'idempotencyKey'],
  properties: {
    sourceProjectId: { type: 'integer', minimum: 1 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const mergeResponseSwaggerSchema = {
  type: 'object',
  required: ['targetProjectId', 'sourceProjectId', 'movedOrdersCount', 'auditId', 'requestId'],
  properties: {
    targetProjectId: { type: 'integer' },
    sourceProjectId: { type: 'integer' },
    movedOrdersCount: { type: 'integer' },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @ApiOperation({ operationId: 'listProjects', summary: 'Получить список проектов' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'clientId', required: false, type: Number })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiResponse({
    status: 200,
    description: 'Список проектов',
    schema: swaggerSchema({ type: 'array', items: projectSwaggerSchema }),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid query params' })
  @Get()
  list(@Req() request: RequestWithCurrentUser, @Query() rawQuery: unknown): Promise<ProjectDto[]> {
    return this.projects.list({
      currentUser: requireCurrentUser(request),
      query: parseListProjectsQuery(rawQuery),
    });
  }

  @ApiOperation({ operationId: 'getProjectById', summary: 'Получить карточку проекта' })
  @ApiResponse({
    status: 200,
    description: 'Карточка проекта',
    schema: swaggerSchema(projectCardSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @Get(':id')
  getById(@Req() request: RequestWithCurrentUser, @Param('id', ParseIntPipe) id: number): Promise<ProjectCard> {
    return this.projects.getById({
      currentUser: requireCurrentUser(request),
      projectId: id,
    });
  }

  @ApiOperation({ operationId: 'createProject', summary: 'Создать проект без заказа' })
  @ApiBody({ schema: swaggerSchema(createProjectSwaggerSchema) })
  @ApiResponse({
    status: 201,
    description: 'Проект создан',
    schema: swaggerSchema(createProjectResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Duplicate code or idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid payload or unknown client' })
  @Post()
  @HttpCode(201)
  create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CreateProjectResult> {
    const parsed = parseCreateProjectBody(body);
    return this.projects.create({
      currentUser: requireCurrentUser(request),
      dto: {
        clientId: parsed.clientId,
        name: parsed.name,
        code: parsed.code,
        notes: parsed.notes,
      },
      idempotencyKey: parsed.idempotencyKey,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'updateProject', summary: 'Обновить проект' })
  @ApiBody({ schema: swaggerSchema(updateProjectSwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Проект обновлён',
    schema: swaggerSchema(projectSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Version conflict or duplicate code' })
  @ApiResponse({ status: 422, description: 'Invalid project payload' })
  @Patch(':id')
  update(@Req() request: RequestWithCurrentUser, @Param('id', ParseIntPipe) id: number, @Body() body: unknown): Promise<ProjectDto> {
    const parsed = parseUpdateProjectBody(body);
    const dto: UpdateProjectDtoBody = {
      code: parsed.code,
      name: parsed.name,
      notes: parsed.notes,
    };

    return this.projects.update({
      currentUser: requireCurrentUser(request),
      projectId: id,
      dto,
      expectedVersion: parsed.expectedVersion,
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'mergeProjects', summary: 'Объединить проекты' })
  @ApiBody({ schema: swaggerSchema(mergeProjectSwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Проекты объединены',
    schema: swaggerSchema(mergeResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid merge payload' })
  @Post(':id/merge')
  @HttpCode(200)
  merge(@Req() request: RequestWithCurrentUser, @Param('id', ParseIntPipe) id: number, @Body() body: unknown): Promise<MergeResult> {
    const dto = parseMergeBody(body);
    return this.projects.merge({
      currentUser: requireCurrentUser(request),
      targetProjectId: id,
      sourceProjectId: dto.sourceProjectId,
      idempotencyKey: dto.idempotencyKey,
      requestId: request.requestId,
    });
  }
}

export function parseListProjectsQuery(query: unknown) {
  return parseWithZod(listProjectsSchema, query);
}

export function parseUpdateProjectBody(body: unknown) {
  return parseWithZod(updateProjectSchema, body);
}

export function parseMergeBody(body: unknown) {
  return parseWithZod(mergeSchema, body);
}

export function parseCreateProjectBody(body: unknown) {
  return parseWithZod(createProjectSchema, body);
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }

  return request.user;
}

function parseWithZod<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }

  return parsed.data;
}

function validationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Project payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
