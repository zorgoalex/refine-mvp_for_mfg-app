import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PROJECT_ENTITY_TYPE_CODES } from '../entity-links/project-entity-registry';
import { parseProjectId } from '../projects.controller';
import { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import {
  parseProjectBatchLinkRequest,
  type ProjectBatchLinkResponseDto,
} from './project-batch-link.dto';
import { ProjectBatchLinkService } from './project-batch-link.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const batchLinkRequestSwaggerSchema = {
  type: 'object',
  required: ['mode', 'fixtureKey', 'idempotencyKey', 'entityType', 'source', 'items'],
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['dry-run'] },
    fixtureKey: { type: 'string', minLength: 1, maxLength: 200 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    entityType: { type: 'string', enum: PROJECT_ENTITY_TYPE_CODES },
    source: {
      type: 'object',
      required: ['type', 'reference'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', minLength: 1, maxLength: 100 },
        reference: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    items: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['entityId', 'reason', 'confidence'],
        additionalProperties: false,
        properties: {
          entityId: { type: 'string', minLength: 1, maxLength: 200 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          confidence: { type: 'string', minLength: 1, maxLength: 100 },
          sourceRow: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  },
} as const;

const batchLinkResponseSwaggerSchema = {
  type: 'object',
  required: ['projectId', 'mode', 'summary', 'proposals', 'skipped', 'sampleEvidence', 'writeEnabled'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', format: 'uuid' },
    mode: { type: 'string', enum: ['dry-run'] },
    summary: {
      type: 'object',
      required: ['proposed', 'skipped', 'conflicts', 'sampledEvidenceRows'],
      additionalProperties: false,
      properties: {
        proposed: { type: 'integer', minimum: 0 },
        skipped: { type: 'integer', minimum: 0 },
        conflicts: { type: 'integer', minimum: 0 },
        sampledEvidenceRows: { type: 'integer', minimum: 0 },
      },
    },
    proposals: { type: 'array', items: { type: 'object', additionalProperties: true } },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
    sampleEvidence: { type: 'array', items: { type: 'object', additionalProperties: true } },
    writeEnabled: { type: 'boolean', enum: [false] },
  },
} as const;

@ApiTags('Projects')
@ApiBearerAuth('bearerAuth')
@Controller('projects/:projectId/batch-link')
export class ProjectBatchLinkController {
  constructor(
    @Inject(ProjectBatchLinkService)
    private readonly batchLinks: ProjectBatchLinkService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly runtimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'projectId', type: String, description: 'Project UUID' })
  @ApiBody({ schema: swaggerSchema(batchLinkRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Dry-run project batch link proposals', schema: swaggerSchema(batchLinkResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid project id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid payload or non-dry-run mode' })
  @ApiResponse({ status: 503, description: 'Projects API is disabled' })
  @ApiOperation({ operationId: 'dryRunProjectBatchLink', summary: 'Dry-run project batch link proposals' })
  @Post()
  @HttpCode(200)
  async dryRun(
    @Req() request: RequestWithCurrentUser,
    @Param('projectId') projectIdParam: string,
    @Body() body: unknown,
  ): Promise<ProjectBatchLinkResponseDto> {
    this.assertProjectsEnabled();
    return this.batchLinks.dryRun({
      currentUser: this.requireCurrentUser(request),
      projectId: parseProjectId(projectIdParam),
      dto: parseProjectBatchLinkRequest(body),
      requestId: request.requestId,
    });
  }

  private assertProjectsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', { feature: 'projects' });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
