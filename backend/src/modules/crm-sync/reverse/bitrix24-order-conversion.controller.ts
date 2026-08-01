import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

const bodySchema = z.object({
  version: z.number().int().positive(),
  orderName: z.string().trim().min(1).max(200),
  projectId: z.number().int().positive().nullable().optional(),
  createProject: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine((value, context) => {
  const hasProject = value.projectId !== null && value.projectId !== undefined;
  if (hasProject === value.createProject) {
    context.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'Exactly one of projectId and createProject=true is required',
    });
  }
});

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('orders')
export class Bitrix24OrderConversionController {
  constructor(
    private readonly repository: PgBitrix24ReverseRepository,
    private readonly config: CrmSyncRuntimeConfigService,
  ) {}

  @ApiOperation({ summary: 'Convert a Bitrix CRM request into a production order' })
  @Post(':orderId/convert-to-production')
  @HttpCode(200)
  @RequirePermissions('bitrix24.requests.convert')
  convert(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') rawOrderId: string,
    @Body() rawBody: unknown,
  ) {
    const user = request.user;
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const orderId = z.coerce.number().int().positive().safeParse(rawOrderId);
    const body = bodySchema.safeParse(rawBody);
    if (!orderId.success || !body.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'CRM request conversion payload is invalid');
    }
    const reverse = this.config.getReverseSync();
    if (!reverse.initialOrderStatusCode || !reverse.initialProductionStatusCode) {
      throw new ApiError(503, 'ORDER_INITIAL_STATUS_INVALID', 'Initial production statuses are not configured');
    }
    if (!this.config.isProductionInitializationReady()) {
      throw new ApiError(
        503,
        'ORDER_PRODUCTION_INITIALIZER_UNAVAILABLE',
        'Production deadline initialization is unavailable',
      );
    }
    return this.repository.convertCrmRequestToProduction({
      orderId: orderId.data,
      expectedVersion: body.data.version,
      orderName: body.data.orderName,
      projectId: body.data.projectId ?? null,
      createProject: body.data.createProject,
      idempotencyKey: body.data.idempotencyKey,
      actorUserId: Number(user.id),
      actorUsername: user.username,
      actorRole: user.role,
      requestId: request.requestId ?? 'crm-request-conversion',
      scope: requestScope(user),
      initialOrderStatusCode: reverse.initialOrderStatusCode,
      initialProductionStatusCode: reverse.initialProductionStatusCode,
    });
  }
}

function requestScope(user: NonNullable<RequestWithCurrentUser['user']>) {
  if (user.role === 'superadmin' || user.role === 'admin' || user.role === 'top_manager') {
    return { mode: 'all' as const };
  }
  if (user.role === 'manager') {
    return { mode: 'assigned' as const, userId: Number(user.id) };
  }
  throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient Bitrix24 request scope');
}
