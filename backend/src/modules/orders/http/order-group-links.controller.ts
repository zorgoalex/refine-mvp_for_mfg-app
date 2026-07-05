import { Body, Controller, Get, HttpCode, Inject, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { GroupsRuntimeConfigService } from '../../groups/groups-runtime-config.service';
import { OrderGroupLinkService } from '../application/order-group-link.service';
import type {
  OrderGroupsResponseDto,
  ReplaceOrderGroupsRequestDto,
  ReplaceOrderGroupsResponseDto,
} from '../dto/order-group-link.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';
import { parseOrderId, rejectUnsupportedGroupTemporalQuery } from './orders.controller';

const relationTypes = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;
const uuidSchema = z.string().uuid();
const replaceOrderGroupsSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    version: z.number().int().nonnegative(),
    primaryGroupId: uuidSchema.nullable().optional(),
    groups: z.array(z.object({
      groupId: uuidSchema,
      relationType: z.enum(relationTypes).default('main'),
      isPrimary: z.boolean().default(false),
    })).max(100),
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .transform((value) => {
    const primaryGroupId = value.primaryGroupId ? canonicalizeUuid(value.primaryGroupId) : value.primaryGroupId;
    return {
      ...value,
      primaryGroupId,
      groups: value.groups.map((group) => {
        const groupId = canonicalizeUuid(group.groupId);
        return {
          ...group,
          groupId,
          isPrimary: group.isPrimary || (!!primaryGroupId && groupId === primaryGroupId),
        };
      }),
    };
  })
  .refine((value) => {
    const primaryCount = value.groups.filter((group) =>
      group.isPrimary || group.groupId === value.primaryGroupId,
    ).length;
    return primaryCount <= 1;
  }, {
    path: ['groups'],
    message: 'Only one group can be primary',
  })
  .refine((value) => !value.primaryGroupId || value.groups.some((group) => group.groupId === value.primaryGroupId), {
    path: ['primaryGroupId'],
    message: 'primaryGroupId must reference one of the submitted groups',
  });

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const groupSummarySwaggerSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'relationType', 'isPrimary', 'validFrom'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    relationType: { type: 'string', enum: relationTypes },
    isPrimary: { type: 'boolean' },
    validFrom: { type: 'string', format: 'date-time' },
  },
} as const;

const orderGroupsResponseSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'version', 'primaryGroup', 'groups', 'requestId'],
  properties: {
    orderId: { type: 'integer' },
    version: { type: 'integer' },
    primaryGroup: { ...groupSummarySwaggerSchema, nullable: true },
    groups: { type: 'array', items: groupSummarySwaggerSchema },
    requestId: { type: 'string' },
  },
} as const;

const replaceOrderGroupsRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey', 'version', 'groups'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
    version: { type: 'integer', minimum: 0 },
    primaryGroupId: { type: 'string', format: 'uuid', nullable: true },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['groupId', 'relationType', 'isPrimary'],
        properties: {
          groupId: { type: 'string', format: 'uuid' },
          relationType: { type: 'string', enum: relationTypes, default: 'main' },
          isPrimary: { type: 'boolean', default: false },
        },
      },
    },
    reason: { type: 'string', nullable: true, maxLength: 1000 },
  },
} as const;

const replaceOrderGroupsResponseSwaggerSchema = {
  ...orderGroupsResponseSwaggerSchema,
  required: [...orderGroupsResponseSwaggerSchema.required, 'changed'],
  properties: {
    ...orderGroupsResponseSwaggerSchema.properties,
    changed: { type: 'boolean' },
    auditId: { type: 'string' },
  },
} as const;

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/:orderId/groups')
export class OrderGroupLinksController {
  constructor(
    @Inject(OrderGroupLinkService)
    private readonly links: OrderGroupLinkService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
    @Inject(GroupsRuntimeConfigService)
    private readonly groupsRuntimeConfig: GroupsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Current order group links', schema: swaggerSchema(orderGroupsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 422, description: 'Temporal group queries are not supported in P1-P3' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderGroups', summary: 'Get current order group links' })
  @Get()
  async get(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Query() query: Record<string, string | string[] | undefined> = {},
  ): Promise<OrderGroupsResponseDto> {
    this.assertOrdersReadEnabled();
    this.assertGroupsEnabled();
    rejectUnsupportedGroupTemporalQuery(query);
    return this.links.get({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(replaceOrderGroupsRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced current order group links', schema: swaggerSchema(replaceOrderGroupsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid group link payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'replaceOrderGroups', summary: 'Replace current order group links' })
  @Put()
  @HttpCode(200)
  async replace(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ReplaceOrderGroupsResponseDto> {
    this.assertOrdersWriteEnabled();
    this.assertGroupWritesEnabled();
    return this.links.replace({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseReplaceOrderGroupsRequest(body),
      requestId: request.requestId,
    });
  }

  private assertOrdersReadEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
  }

  private assertOrdersWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
    if (flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders write API is disabled', {
        feature: 'orders',
        mode: 'read_only',
      });
    }
  }

  private assertGroupsEnabled(): void {
    if (!this.groupsRuntimeConfig.getFeatureFlags().groupsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Groups API is disabled', {
        feature: 'groups',
      });
    }
  }

  private assertGroupWritesEnabled(): void {
    this.assertGroupsEnabled();

    if (this.groupsRuntimeConfig.getFeatureFlags().groupsReadOnly) {
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

function canonicalizeUuid(value: string): string {
  return value.toLowerCase();
}

export function parseReplaceOrderGroupsRequest(body: unknown): ReplaceOrderGroupsRequestDto {
  const parsed = replaceOrderGroupsSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Order group link payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
