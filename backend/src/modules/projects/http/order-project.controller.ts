import { Body, Controller, HttpCode, Inject, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { MoveOrderResult } from '../application/projects.types';
import { ProjectsService } from '../application/projects.service';
import { moveOrderSchema } from '../dto/projects.dto';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const moveOrderRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey'],
  properties: {
    targetProjectId: { type: 'integer', minimum: 1 },
    createNew: { type: 'boolean' },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const moveOrderResponseSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'projectId', 'code', 'archivedSourceProjectId', 'auditId', 'requestId'],
  properties: {
    orderId: { type: 'integer' },
    projectId: { type: 'integer' },
    code: { type: 'string' },
    archivedSourceProjectId: { type: 'integer', nullable: true },
    auditId: { type: 'integer' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('orders')
export class OrderProjectController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @ApiOperation({ operationId: 'moveOrderProject', summary: 'Перенести заказ в проект' })
  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(moveOrderRequestSwaggerSchema) })
  @ApiResponse({
    status: 200,
    description: 'Заказ перенесён в проект',
    schema: swaggerSchema(moveOrderResponseSwaggerSchema),
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order or project not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid move-order payload' })
  @Post(':orderId/project')
  @HttpCode(200)
  move(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() body: unknown,
  ): Promise<MoveOrderResult> {
    const dto = parseMoveOrderBody(body);
    return this.projects.moveOrder({
      currentUser: requireCurrentUser(request),
      orderId,
      ...dto,
      requestId: request.requestId,
    });
  }
}

export function parseMoveOrderBody(body: unknown) {
  return parseWithZod(moveOrderSchema, body);
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
