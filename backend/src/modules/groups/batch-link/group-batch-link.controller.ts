import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { GROUP_ENTITY_TYPE_CODES } from '../entity-links/group-entity-registry';
import { parseGroupId } from '../groups.controller';
import { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import {
  parseGroupBatchLinkRequest,
  type GroupBatchLinkResponseDto,
} from './group-batch-link.dto';
import { GroupBatchLinkService } from './group-batch-link.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const batchLinkRequestSwaggerSchema = {
  type: 'object',
  required: ['mode', 'fixtureKey', 'idempotencyKey', 'entityType', 'relationType', 'source', 'items'],
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['dry-run', 'write'] },
    writeIntent: { type: 'string', enum: ['explicit-selected-ids'] },
    fixtureKey: { type: 'string', minLength: 1, maxLength: 200 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    entityType: { type: 'string', enum: GROUP_ENTITY_TYPE_CODES },
    relationType: { type: 'string', minLength: 1, maxLength: 100 },
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
  required: ['groupId', 'mode', 'summary', 'proposals', 'skipped', 'sampleEvidence', 'writeEnabled'],
  additionalProperties: false,
  properties: {
    groupId: { type: 'string', format: 'uuid' },
    mode: { type: 'string', enum: ['dry-run', 'write'] },
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
    changed: { type: 'boolean' },
    auditId: { type: 'string', nullable: true },
    outboxEventId: { type: 'string', nullable: true },
    requestId: { type: 'string', nullable: true },
    writeEnabled: { type: 'boolean' },
  },
} as const;

@ApiTags('Groups')
@ApiBearerAuth('bearerAuth')
@Controller('groups/:groupId/batch-link')
export class GroupBatchLinkController {
  constructor(
    @Inject(GroupBatchLinkService)
    private readonly batchLinks: GroupBatchLinkService,
    @Inject(GroupsRuntimeConfigService)
    private readonly runtimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'groupId', type: String, description: 'Group UUID' })
  @ApiBody({ schema: swaggerSchema(batchLinkRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Group batch link dry-run or write result', schema: swaggerSchema(batchLinkResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid group id' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid payload' })
  @ApiResponse({ status: 503, description: 'Groups API is disabled' })
  @ApiOperation({ operationId: 'executeGroupBatchLink', summary: 'Dry-run or write explicitly selected group batch links' })
  @Post()
  @HttpCode(200)
  async dryRun(
    @Req() request: RequestWithCurrentUser,
    @Param('groupId') groupIdParam: string,
    @Body() body: unknown,
  ): Promise<GroupBatchLinkResponseDto> {
    this.assertGroupsEnabled();
    const currentUser = this.requireCurrentUser(request);
    const groupId = parseGroupId(groupIdParam);
    const dto = parseGroupBatchLinkRequest(body);
    const command = {
      currentUser,
      groupId,
      dto,
      requestId: request.requestId,
    };
    if (dto.mode === 'write') {
      this.assertBatchWriteEnabled();
      return this.batchLinks.write(command);
    }
    return this.batchLinks.dryRun(command);
  }

  private assertGroupsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', { feature: 'groups' });
    }
  }

  private assertBatchWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (flags.groupsReadOnly || !flags.groupsBatchLinkWriteEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups batch link write mode is disabled', {
        feature: 'groups',
        writeEnabled: false,
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}
