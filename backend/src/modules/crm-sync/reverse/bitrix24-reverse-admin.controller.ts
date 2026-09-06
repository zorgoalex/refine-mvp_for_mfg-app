import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { Bitrix24ReverseProcessorService } from './bitrix24-reverse-processor.service';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

const positiveId = z.coerce.number().int().positive();
const requestDetailSchema = z.object({
  id: positiveId.optional(),
  detailName: z.string().trim().max(200).nullable().optional(),
  height: z.coerce.number().positive().max(1_000_000),
  width: z.coerce.number().positive().max(1_000_000),
  quantity: z.coerce.number().int().positive().max(1_000_000),
  sheetMaterialTypeId: positiveId,
  millingTypeId: positiveId,
  edgeTypeId: positiveId,
  filmId: positiveId.nullable().optional(),
  millingCostPerSqm: z.coerce.number().nonnegative().max(1_000_000_000).nullable().optional(),
  detailCost: z.coerce.number().nonnegative().max(1_000_000_000).nullable().optional(),
  priority: z.coerce.number().int().min(0).max(100).default(100),
  note: z.string().trim().max(10_000).nullable().optional(),
}).strict();

@ApiTags('Bitrix24')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('bitrix24')
export class Bitrix24ReverseAdminController {
  constructor(
    private readonly repository: PgBitrix24ReverseRepository,
    private readonly processor: Bitrix24ReverseProcessorService,
  ) {}

  @ApiOperation({ summary: 'List Bitrix24 incoming requests' })
  @Get('incoming-requests')
  @RequirePermissions('bitrix24.requests.view')
  listIncomingRequests(
    @Req() request: RequestWithCurrentUser,
    @Query('state') state?: string,
    @Query('search') search?: string,
    @Query('stageId') stageId?: string,
    @Query('assignedById') assignedById?: string,
    @Query('clientId') clientId?: string,
    @Query('updatedFrom') updatedFrom?: string,
    @Query('updatedTo') updatedTo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const actor = requireUser(request);
    const parsed = z.object({
      state: z.enum(['unresolved', 'active', 'converted', 'archived']).optional(),
      search: z.string().trim().min(1).max(200).optional(),
      stageId: z.string().trim().min(1).max(100).optional(),
      assignedById: z.string().regex(/^[1-9][0-9]*$/).optional(),
      clientId: positiveId.optional(),
      updatedFrom: z.coerce.date().optional(),
      updatedTo: z.coerce.date().optional(),
      page: positiveId.default(1),
      pageSize: positiveId.max(100).default(25),
    }).refine(
      (value) =>
        !value.updatedFrom ||
        !value.updatedTo ||
        value.updatedFrom.getTime() <= value.updatedTo.getTime(),
      { path: ['updatedTo'], message: 'updatedTo must not precede updatedFrom' },
    ).safeParse({
      state: state || undefined,
      search: search || undefined,
      stageId: stageId || undefined,
      assignedById: assignedById || undefined,
      clientId: clientId || undefined,
      updatedFrom: updatedFrom || undefined,
      updatedTo: updatedTo || undefined,
      page,
      pageSize,
    });
    if (!parsed.success) throw validationError(parsed.error);
    return this.repository.listIncomingRequests({
      ...parsed.data,
      scope: crmRequestScope(actor),
      canViewFinancials: actor.permissions.includes('orders.view_financials'),
    });
  }

  @ApiOperation({ summary: 'Get one Bitrix24 incoming request' })
  @Get('incoming-requests/:requestId')
  @RequirePermissions('bitrix24.requests.view')
  getIncomingRequest(
    @Req() request: RequestWithCurrentUser,
    @Param('requestId') requestId: string,
  ) {
    const actor = requireUser(request);
    return this.repository.getIncomingRequest(
      parseId(requestId, 'requestId'),
      crmRequestScope(actor),
      actor.permissions.includes('orders.view_financials'),
    );
  }

  @ApiOperation({ summary: 'Replace details of an active Bitrix24 CRM request' })
  @Put('incoming-requests/:requestId/details')
  @RequirePermissions('bitrix24.requests.update')
  replaceIncomingRequestDetails(
    @Req() request: RequestWithCurrentUser,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const actor = requireUser(request);
    const parsed = z.object({
      orderVersion: z.coerce.number().int().positive(),
      details: z.array(requestDetailSchema).max(1_000),
    }).strict().safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return this.repository.replaceIncomingRequestDetails({
      requestId: parseId(requestId, 'requestId'),
      orderVersion: parsed.data.orderVersion,
      details: parsed.data.details,
      actorUserId: Number(actor.id),
      actorUsername: actor.username,
      actorRole: actor.role,
      auditRequestId: requireRequestId(request),
      scope: crmRequestScope(actor),
      canViewFinancials: actor.permissions.includes('orders.view_financials'),
    });
  }

  @ApiOperation({ summary: 'Archive an active Bitrix24 CRM request in ERP only' })
  @Post('incoming-requests/:requestId/archive')
  @HttpCode(200)
  @RequirePermissions('bitrix24.requests.update')
  archiveIncomingRequest(
    @Req() request: RequestWithCurrentUser,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const actor = requireUser(request);
    const parsed = z.object({
      orderVersion: z.coerce.number().int().positive(),
    }).strict().safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return this.repository.archiveIncomingRequest({
      requestId: parseId(requestId, 'requestId'),
      expectedVersion: parsed.data.orderVersion,
      actorUserId: Number(actor.id),
      actorUsername: actor.username,
      actorRole: actor.role,
      auditRequestId: requireRequestId(request),
      scope: crmRequestScope(actor),
    });
  }

  @ApiOperation({ summary: 'Materialize confirmed Bitrix24 request payments' })
  @Post('incoming-requests/:requestId/materialize-payments')
  @HttpCode(200)
  @RequirePermissions(['bitrix24.payments.materialize', 'orders.view_financials'])
  materializePayments(
    @Req() request: RequestWithCurrentUser,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const actor = requireUser(request);
    const parsed = materializePaymentsSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return this.repository.materializeRequestPayments({
      requestId: parseId(requestId, 'requestId'),
      bitrixPaymentIds: parsed.data.bitrixPaymentIds,
      expectedOrderVersion: parsed.data.expectedOrderVersion,
      actorUserId: actor.id,
      auditRequestId: requireRequestId(request),
      scope: crmRequestScope(actor),
    });
  }

  @ApiOperation({ summary: 'Materialize confirmed Bitrix24 payments for a mapped ERP order' })
  @Post('mapped-orders/:orderId/materialize-payments')
  @HttpCode(200)
  @RequirePermissions(['bitrix24.payments.materialize', 'orders.view_financials'])
  materializeMappedOrderPayments(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    const actor = requireUser(request);
    const parsed = materializePaymentsSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return this.repository.materializeMappedOrderPayments({
      orderId: parseId(orderId, 'orderId'),
      bitrixPaymentIds: parsed.data.bitrixPaymentIds,
      expectedOrderVersion: parsed.data.expectedOrderVersion,
      actorUserId: actor.id,
      auditRequestId: requireRequestId(request),
      scope: crmRequestScope(actor),
    });
  }

  @ApiOperation({ summary: 'List Bitrix24 payment snapshots for a mapped ERP order' })
  @Get('mapped-orders/:orderId/payments')
  @RequirePermissions('orders.view_financials')
  getMappedOrderPayments(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
  ) {
    const actor = requireUser(request);
    return this.repository.getMappedOrderPayments(
      parseId(orderId, 'orderId'),
      crmRequestScope(actor),
    );
  }

  @ApiOperation({ summary: 'Refresh Bitrix24 payment snapshots for a mapped ERP order' })
  @Post('mapped-orders/:orderId/reconcile-payments')
  @HttpCode(200)
  @RequirePermissions('orders.view_financials')
  async reconcileMappedOrderPayments(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdValue: string,
  ) {
    const actor = requireUser(request);
    const orderId = parseId(orderIdValue, 'orderId');
    const scope = crmRequestScope(actor);
    const current = await this.repository.getMappedOrderPayments(orderId, scope);
    if (current.linked !== true || typeof current.bitrixDealId !== 'string') {
      return current;
    }
    await this.processor.reconcileMappedOrderPaymentsNow({
      dealId: current.bitrixDealId,
      orderId,
      auditRequestId: requireRequestId(request),
    });
    return this.repository.getMappedOrderPayments(orderId, scope);
  }

  @ApiOperation({ summary: 'List Bitrix24 responsible-user mappings' })
  @Get('user-mappings')
  @RequirePermissions('bitrix24.integration.manage')
  listUserMappings() {
    return this.repository.listUserMappings();
  }

  @ApiOperation({ summary: 'List eligible ERP targets for Bitrix24 user mappings' })
  @Get('user-mapping-targets')
  @RequirePermissions('bitrix24.integration.manage')
  listUserMappingTargets() {
    return this.repository.listUserMappingTargets();
  }

  @ApiOperation({ summary: 'Create, change, or deactivate a Bitrix24 user mapping' })
  @Put('user-mappings/:bitrixUserId')
  @RequirePermissions('bitrix24.integration.manage')
  updateUserMapping(
    @Req() request: RequestWithCurrentUser,
    @Param('bitrixUserId') bitrixUserId: string,
    @Body() body: unknown,
  ) {
    const actor = requireUser(request);
    const identity = z.string().regex(/^[1-9][0-9]*$/).safeParse(bitrixUserId);
    const parsed = z.object({
      erpUserId: positiveId,
      active: z.boolean(),
    }).strict().safeParse(body);
    if (!identity.success || !parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Bitrix24 user mapping is invalid');
    }
    return this.repository.upsertUserMapping({
      bitrixUserId: identity.data,
      erpUserId: parsed.data.erpUserId,
      active: parsed.data.active,
      actorUserId: actor.id,
      actorUsername: actor.username,
      actorRole: actor.role,
      auditRequestId: requireRequestId(request),
    });
  }

  @ApiOperation({ summary: 'List Bitrix24 payment system mappings' })
  @Get('payment-type-mappings')
  @RequirePermissions('bitrix24.integration.manage')
  listPaymentMappings() {
    return this.repository.listPaymentTypeMappings();
  }

  @ApiOperation({ summary: 'Update Bitrix24 payment system mapping' })
  @Put('payment-type-mappings/:paySystemId')
  @RequirePermissions('bitrix24.integration.manage')
  updatePaymentMapping(
    @Req() request: RequestWithCurrentUser,
    @Param('paySystemId') paySystemId: string,
    @Body() body: unknown,
  ) {
    const actor = requireUser(request);
    const parsed = z.object({
      typePaidId: positiveId,
      active: z.boolean(),
      widgetEnabled: z.boolean().optional(),
      isDefault: z.boolean().optional(),
    }).strict().safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return this.repository.upsertPaymentTypeMapping({
      paySystemId: parseId(paySystemId, 'paySystemId'),
      typePaidId: parsed.data.typePaidId,
      active: parsed.data.active,
      widgetEnabled: parsed.data.widgetEnabled,
      isDefault: parsed.data.isDefault,
      actorUserId: actor.id,
      auditRequestId: requireRequestId(request),
    });
  }

  @ApiOperation({ summary: 'Get Bitrix24 reverse synchronization health' })
  @Get('sync-health')
  @RequirePermissions('bitrix24.integration.manage')
  syncHealth() {
    return this.repository.getSyncHealth();
  }

  @ApiOperation({ summary: 'Retry failed Bitrix24 inbound events' })
  @Post('sync-health/retry-failed')
  @HttpCode(200)
  @RequirePermissions('bitrix24.integration.manage')
  async retryFailed(@Req() request: RequestWithCurrentUser) {
    const actor = requireUser(request);
    return {
      retried: await this.repository.retryFailedEvents({
        actorUserId: actor.id,
        auditRequestId: requireRequestId(request),
      }),
    };
  }
}

const materializePaymentsSchema = z.object({
  bitrixPaymentIds: z.array(z.string().regex(/^[1-9][0-9]*$/)).min(1).max(500)
    .refine((values) => new Set(values).size === values.length, 'Payment IDs must be unique'),
  expectedOrderVersion: positiveId,
}).strict();

function parseId(value: string, field: string): number {
  const parsed = positiveId.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be a positive integer`, {
      field,
    });
  }
  return parsed.data;
}

function requireUser(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function crmRequestScope(user: NonNullable<RequestWithCurrentUser['user']>) {
  if (user.role === 'superadmin' || user.role === 'admin' || user.role === 'top_manager') {
    return { mode: 'all' as const };
  }
  if (user.role === 'manager' || user.role === 'operator') {
    return { mode: 'assigned' as const, userId: Number(user.id) };
  }
  throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient Bitrix24 request scope');
}

function requireRequestId(request: RequestWithCurrentUser): string {
  if (!request.requestId) throw new ApiError(500, 'REQUEST_ID_MISSING', 'Request ID missing');
  return request.requestId;
}

function validationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Bitrix24 request validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
