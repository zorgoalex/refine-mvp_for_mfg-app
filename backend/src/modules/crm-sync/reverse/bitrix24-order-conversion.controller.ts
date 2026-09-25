import { humanName } from '../../../shared/human-name-schema';
import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';
import { Bitrix24ProductSyncService } from './bitrix24-product-sync.service';

const bodySchema = z.object({
  version: z.number().int().positive(),
  orderName: humanName(200, 1),
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
    private readonly productSync?: Bitrix24ProductSyncService,
  ) {}

  @ApiOperation({ summary: 'Convert a Bitrix CRM request into a production order' })
  @Post(':orderId/convert-to-production')
  @HttpCode(200)
  @RequirePermissions('bitrix24.requests.convert')
  async convert(
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
    // Authorize scope BEFORE any remote presync or mutation; a manager must
    // not be able to trigger work on another user's linked request.
    const scope = requestScope(user);
    const link = await this.repository.findRequestLinkByOrderId(orderId.data, scope);
    if (!link) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    // Presync only ACTIVE requests: a converted request's idempotent replay is
    // resolved inside the conversion transaction with no remote calls.
    if (this.productSync && link.state === 'active') {
      const sync = await this.productSync.syncForOrderId(
        orderId.data,
        request.requestId ?? 'crm-request-conversion',
      );
      if (sync.status === 'blocked') {
        throw new ApiError(
          409,
          'BITRIX24_PRODUCTS_BLOCKED',
          `Bitrix24 product rows are blocked: ${sync.reason ?? 'unknown'}`,
        );
      }
      if (sync.status === 'skipped') {
        // The required refresh did not apply for this still-active request
        // (stale fence, broken mapping, non-active state transition raced the
        // discovery). A leftover 'ready' certificate must not convert.
        const fresh = await this.repository.findRequestLinkByOrderId(
          orderId.data,
          scope,
        );
        if (fresh?.state === 'active') {
          throw new ApiError(
            409,
            'BITRIX24_PRODUCT_SYNC_FAILED',
            'Bitrix24 product refresh did not apply; reconcile the request and retry',
          );
        }
      }
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
