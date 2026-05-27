import { Body, Controller, Get, HttpCode, Inject, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ProjectsRuntimeConfigService } from '../../projects/projects-runtime-config.service';
import { OrderProjectLinkService } from '../application/order-project-link.service';
import type {
  OrderProjectsResponseDto,
  ReplaceOrderProjectsRequestDto,
  ReplaceOrderProjectsResponseDto,
} from '../dto/order-project-link.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';
import { parseOrderId, rejectUnsupportedProjectTemporalQuery } from './orders.controller';

const relationTypes = ['main', 'secondary', 'reporting', 'billing', 'derived'] as const;
const uuidSchema = z.string().uuid();
const replaceOrderProjectsSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    version: z.number().int().nonnegative(),
    primaryProjectId: uuidSchema.nullable().optional(),
    projects: z.array(z.object({
      projectId: uuidSchema,
      relationType: z.enum(relationTypes).default('main'),
      isPrimary: z.boolean().default(false),
    })).max(100),
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .transform((value) => {
    const primaryProjectId = value.primaryProjectId ? canonicalizeUuid(value.primaryProjectId) : value.primaryProjectId;
    return {
      ...value,
      primaryProjectId,
      projects: value.projects.map((project) => {
        const projectId = canonicalizeUuid(project.projectId);
        return {
          ...project,
          projectId,
          isPrimary: project.isPrimary || (!!primaryProjectId && projectId === primaryProjectId),
        };
      }),
    };
  })
  .refine((value) => {
    const primaryCount = value.projects.filter((project) =>
      project.isPrimary || project.projectId === value.primaryProjectId,
    ).length;
    return primaryCount <= 1;
  }, {
    path: ['projects'],
    message: 'Only one project can be primary',
  })
  .refine((value) => !value.primaryProjectId || value.projects.some((project) => project.projectId === value.primaryProjectId), {
    path: ['primaryProjectId'],
    message: 'primaryProjectId must reference one of the submitted projects',
  });

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const projectSummarySwaggerSchema = {
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

const orderProjectsResponseSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'version', 'primaryProject', 'projects', 'requestId'],
  properties: {
    orderId: { type: 'integer' },
    version: { type: 'integer' },
    primaryProject: { ...projectSummarySwaggerSchema, nullable: true },
    projects: { type: 'array', items: projectSummarySwaggerSchema },
    requestId: { type: 'string' },
  },
} as const;

const replaceOrderProjectsRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey', 'version', 'projects'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
    version: { type: 'integer', minimum: 0 },
    primaryProjectId: { type: 'string', format: 'uuid', nullable: true },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['projectId', 'relationType', 'isPrimary'],
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          relationType: { type: 'string', enum: relationTypes, default: 'main' },
          isPrimary: { type: 'boolean', default: false },
        },
      },
    },
    reason: { type: 'string', nullable: true, maxLength: 1000 },
  },
} as const;

const replaceOrderProjectsResponseSwaggerSchema = {
  ...orderProjectsResponseSwaggerSchema,
  required: [...orderProjectsResponseSwaggerSchema.required, 'changed'],
  properties: {
    ...orderProjectsResponseSwaggerSchema.properties,
    changed: { type: 'boolean' },
    auditId: { type: 'string' },
  },
} as const;

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/:orderId/projects')
export class OrderProjectLinksController {
  constructor(
    @Inject(OrderProjectLinkService)
    private readonly links: OrderProjectLinkService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
    @Inject(ProjectsRuntimeConfigService)
    private readonly projectsRuntimeConfig: ProjectsRuntimeConfigService,
  ) {}

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Current order project links', schema: swaggerSchema(orderProjectsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 422, description: 'Temporal project queries are not supported in P1-P3' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderProjects', summary: 'Get current order project links' })
  @Get()
  async get(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Query() query: Record<string, string | string[] | undefined> = {},
  ): Promise<OrderProjectsResponseDto> {
    this.assertOrdersReadEnabled();
    this.assertProjectsEnabled();
    rejectUnsupportedProjectTemporalQuery(query);
    return this.links.get({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(replaceOrderProjectsRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Replaced current order project links', schema: swaggerSchema(replaceOrderProjectsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 422, description: 'Invalid project link payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'replaceOrderProjects', summary: 'Replace current order project links' })
  @Put()
  @HttpCode(200)
  async replace(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() body: unknown,
  ): Promise<ReplaceOrderProjectsResponseDto> {
    this.assertOrdersWriteEnabled();
    this.assertProjectWritesEnabled();
    return this.links.replace({
      currentUser: this.requireCurrentUser(request),
      orderId: parseOrderId(orderIdParam),
      dto: parseReplaceOrderProjectsRequest(body),
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

  private assertProjectsEnabled(): void {
    if (!this.projectsRuntimeConfig.getFeatureFlags().projectsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is disabled', {
        feature: 'projects',
      });
    }
  }

  private assertProjectWritesEnabled(): void {
    this.assertProjectsEnabled();

    if (this.projectsRuntimeConfig.getFeatureFlags().projectsReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Projects API is read-only', {
        feature: 'projects',
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

export function parseReplaceOrderProjectsRequest(body: unknown): ReplaceOrderProjectsRequestDto {
  const parsed = replaceOrderProjectsSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Order project link payload validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
