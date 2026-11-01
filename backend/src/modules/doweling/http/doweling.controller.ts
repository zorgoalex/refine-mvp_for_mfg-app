import { humanName } from '../../../shared/human-name-schema';
import { Body, Controller, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DowelingService } from '../application/doweling.service';
import type {
  CreateDowelingOrderRequestDto,
  CreateDowelingOrderResponseDto,
  UpdateDowelingOrderRequestDto,
  UpdateDowelingOrderResponseDto,
} from '../dto/doweling.dto';
import { DOWELING_MONEY_FIELDS } from '../dto/doweling.dto';
import { DowelingRuntimeConfigService } from './doweling-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

// Validate a real calendar date (regex alone accepts 2026-99-99 / 2026-02-30, which Postgres ::date
// would reject as a 500). Reject impossible dates at the 422 validation boundary instead.
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const createDowelingRequestSchema = z.object({
  dowelingOrderName: humanName(200, 1),
  designEngineerId: z.number().int().positive(),
  paymentStatusId: z.number().int().positive().optional(),
  dowelingOrderDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .refine(isRealCalendarDate, 'Invalid calendar date')
    .nullish(),
  productionStatusId: z.number().int().positive().nullish(),
  operatorId: z.number().int().positive().nullish(),
  partsCount: z.number().int().nonnegative().nullish(),
  linkCadFile: z.string().trim().max(2000).nullish(),
  linkPdfFile: z.string().trim().max(2000).nullish(),
  orderId: z.number().int().positive().nullish(),
  clientId: z.number().int().positive().nullish(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

const calendarDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine(isRealCalendarDate, 'Invalid calendar date');
const MAX_AMOUNT = 9_999_999_999.99;
const amount = z.number().finite().nonnegative().max(MAX_AMOUNT).transform((value) => Math.round(value * 100) / 100);
const optionalLink = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((value) => (value ? value : null));
const MAX_LINKED_ORDERS = 50;

const updateDowelingRequestSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    dowelingOrderName: humanName(200, 1),
    dowelingOrderDate: calendarDate,
    paymentStatusId: z.number().int().positive().optional(),
    designEngineerId: z.number().int().positive(),
    productionStatusId: z.number().int().positive().nullable(),
    operatorId: z.number().int().positive().nullable(),
    issueDate: calendarDate.nullable(),
    paymentDate: calendarDate.nullable().optional(),
    partsCount: z.number().int().nonnegative().max(1_000_000),
    totalAmount: amount.nullable().optional(),
    finalAmount: amount.nullable().optional(),
    discount: amount.optional(),
    surcharge: amount.optional(),
    paidAmount: amount.optional(),
    linkCadFile: optionalLink,
    linkPdfFile: optionalLink,
    refKey1c: z
      .string()
      .trim()
      .nullable()
      .transform((value) => (value ? value.toLowerCase() : null))
      .refine((value) => value === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value), 'Ref Key 1C must be a UUID'),
    isActive: z.boolean(),
    orderIds: z.array(z.number().int().positive()).max(MAX_LINKED_ORDERS),
    baseOrderIds: z.array(z.number().int().positive()).max(MAX_LINKED_ORDERS * 4),
    clientId: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.orderIds).size !== value.orderIds.length) {
      context.addIssue({ code: 'custom', path: ['orderIds'], message: 'Order ids must be unique' });
    }
    if (!value.isActive && value.orderIds.length > 0) {
      context.addIssue({ code: 'custom', path: ['orderIds'], message: 'An inactive doweling order has no orders' });
    }
    // Money is all or none: a save without it keeps the money (access groups «финансы»).
    const missing = DOWELING_MONEY_FIELDS.filter((field) => value[field] === undefined);
    if (missing.length > 0 && missing.length < DOWELING_MONEY_FIELDS.length) {
      context.addIssue({ code: 'custom', path: [missing[0]], message: `Money fields go together: missing ${missing.join(', ')}` });
    }
  });

const dowelingIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const createDowelingRequestSwaggerSchema = {
  type: 'object',
  required: ['dowelingOrderName', 'designEngineerId', 'idempotencyKey'],
  properties: {
    dowelingOrderName: { type: 'string', minLength: 1, maxLength: 200 },
    designEngineerId: { type: 'integer' },
    paymentStatusId: { type: 'integer', description: 'Needs orders.view_financials; absent = the status with code unpaid' },
    dowelingOrderDate: { type: 'string', format: 'date', nullable: true },
    productionStatusId: { type: 'integer', nullable: true },
    operatorId: { type: 'integer', nullable: true },
    partsCount: { type: 'integer', minimum: 0, nullable: true },
    linkCadFile: { type: 'string', maxLength: 2000, nullable: true },
    linkPdfFile: { type: 'string', maxLength: 2000, nullable: true },
    orderId: { type: 'integer', nullable: true, description: 'Link to this production order in the same transaction' },
    clientId: { type: 'integer', nullable: true, description: 'Client of the Bazis project; with orderId — the order\'s client' },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const updateDowelingRequestSwaggerSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'expectedVersion', 'dowelingOrderName', 'dowelingOrderDate', 'designEngineerId',
    'productionStatusId', 'operatorId', 'issueDate', 'partsCount', 'linkCadFile', 'linkPdfFile', 'refKey1c', 'isActive',
    'orderIds', 'baseOrderIds',
  ],
  description: 'Money (paymentStatusId, paymentDate, totalAmount, finalAmount, discount, surcharge, paidAmount) is all or none: '
    + 'without it the money stays as it is; with it orders.view_financials is required (403 otherwise).',
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    dowelingOrderName: { type: 'string', minLength: 1, maxLength: 200 },
    dowelingOrderDate: { type: 'string', format: 'date' },
    paymentStatusId: { type: 'integer' },
    designEngineerId: { type: 'integer' },
    productionStatusId: { type: 'integer', nullable: true },
    operatorId: { type: 'integer', nullable: true },
    issueDate: { type: 'string', format: 'date', nullable: true },
    paymentDate: { type: 'string', format: 'date', nullable: true },
    partsCount: { type: 'integer', minimum: 0 },
    totalAmount: { type: 'number', minimum: 0, nullable: true },
    finalAmount: { type: 'number', minimum: 0, nullable: true },
    discount: { type: 'number', minimum: 0 },
    surcharge: { type: 'number', minimum: 0 },
    paidAmount: { type: 'number', minimum: 0 },
    linkCadFile: { type: 'string', maxLength: 2000, nullable: true },
    linkPdfFile: { type: 'string', maxLength: 2000, nullable: true },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
    isActive: { type: 'boolean' },
    orderIds: { type: 'array', maxItems: 50, items: { type: 'integer' }, description: 'Orders linked after the save; empty when inactive' },
    baseOrderIds: { type: 'array', maxItems: 200, items: { type: 'integer' }, description: 'Orders the card showed; 409 DOWELING_LINKS_CONFLICT when they are no longer the current ones' },
    clientId: { type: 'integer', description: 'Client of the Bazis project; absent = unchanged. 409 BAZIS_PROJECT_CLIENT_MISMATCH when its orders or XML projects belong to another client' },
  },
} as const;

const linkSwaggerSchema = {
  type: 'object',
  required: ['orderDowelingLinkId', 'orderId'],
  properties: { orderDowelingLinkId: { type: 'integer' }, orderId: { type: 'integer' } },
} as const;

const updateDowelingResponseSwaggerSchema = {
  type: 'object',
  required: ['dowelingOrder', 'links', 'changed', 'requestId'],
  properties: {
    dowelingOrder: {
      type: 'object',
      required: ['dowelingOrderId', 'dowelingOrderName', 'version', 'isActive'],
      properties: {
        dowelingOrderId: { type: 'integer' },
        dowelingOrderName: { type: 'string' },
        version: { type: 'integer' },
        isActive: { type: 'boolean' },
      },
    },
    links: { type: 'array', items: linkSwaggerSchema },
    changed: { type: 'boolean' },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

const dowelingResponseSwaggerSchema = {
  type: 'object',
  required: ['dowelingOrder', 'requestId'],
  properties: {
    dowelingOrder: {
      type: 'object',
      required: ['dowelingOrderId', 'dowelingOrderName', 'version'],
      properties: {
        dowelingOrderId: { type: 'integer' },
        dowelingOrderName: { type: 'string' },
        version: { type: 'integer' },
      },
    },
    link: { ...linkSwaggerSchema, nullable: true },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Doweling')
@ApiBearerAuth()
@Controller('doweling-orders')
export class DowelingController {
  constructor(
    @Inject(DowelingService)
    private readonly doweling: DowelingService,
    @Inject(DowelingRuntimeConfigService)
    private readonly runtimeConfig: DowelingRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'createDowelingOrder', summary: 'Create a doweling order (quick-create)' })
  @ApiBody({ schema: swaggerSchema(createDowelingRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created doweling order', schema: swaggerSchema(dowelingResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Referenced engineer/payment status not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid doweling order payload' })
  @ApiResponse({ status: 503, description: 'Doweling commands API is disabled or database unavailable' })
  @Post()
  @HttpCode(201)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CreateDowelingOrderResponseDto> {
    this.assertDowelingEnabled();

    return this.doweling.createDowelingOrder({
      currentUser: this.requireCurrentUser(request),
      dto: parseCreateDowelingRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'updateDowelingOrder', summary: 'Change a doweling order and the orders it is linked to' })
  @ApiBody({ schema: swaggerSchema(updateDowelingRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Doweling order after the save', schema: swaggerSchema(updateDowelingResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions or an order outside the update scope' })
  @ApiResponse({ status: 404, description: 'Doweling order, order or reference not found' })
  @ApiResponse({ status: 409, description: 'Stale version, concurrent change or duplicate' })
  @ApiResponse({ status: 422, description: 'Invalid payload or inconsistent amounts' })
  @ApiResponse({ status: 503, description: 'Doweling commands API is disabled or database unavailable' })
  @Patch(':id')
  @HttpCode(200)
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UpdateDowelingOrderResponseDto> {
    this.assertDowelingEnabled();

    return this.doweling.updateDowelingOrder({
      currentUser: this.requireCurrentUser(request),
      dowelingOrderId: parseDowelingOrderId(id),
      dto: parseUpdateDowelingRequest(body),
      requestId: request.requestId,
    });
  }

  private assertDowelingEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().dowelingCommandsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Doweling commands API is disabled', {
        feature: 'dowelingCommands',
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

/**
 * «Базис-проекты»: quick-create of a Bazis project card (the former doweling order) with its client. A new route, so
 * an open tab of the new frontend talking to a previous backend gets 404 instead of a card that silently lost its
 * client. The client is mandatory: given, or the client of `orderId`.
 */
@ApiTags('Bazis projects')
@ApiBearerAuth()
@Controller('bazis/cards')
export class BazisCardsController {
  constructor(
    @Inject(DowelingService)
    private readonly doweling: DowelingService,
    @Inject(DowelingRuntimeConfigService)
    private readonly runtimeConfig: DowelingRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'createBazisProjectCard', summary: 'Create a Bazis project card (quick-create, client required)' })
  @ApiBody({ schema: swaggerSchema({ ...createDowelingRequestSwaggerSchema, required: [...createDowelingRequestSwaggerSchema.required] }) })
  @ApiResponse({ status: 201, description: 'Created Bazis project card', schema: swaggerSchema(dowelingResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict or the client differs from the order client' })
  @ApiResponse({ status: 422, description: 'Invalid payload or no client' })
  @ApiResponse({ status: 503, description: 'Doweling commands API is disabled or database unavailable' })
  @Post()
  @HttpCode(201)
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<CreateDowelingOrderResponseDto> {
    if (!this.runtimeConfig.getFeatureFlags().dowelingCommandsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Doweling commands API is disabled', { feature: 'dowelingCommands' });
    }
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return this.doweling.createDowelingOrder({
      currentUser: request.user,
      dto: parseCreateDowelingRequest(body),
      requestId: request.requestId,
      clientRequired: true,
    });
  }
}

export function parseCreateDowelingRequest(body: unknown): CreateDowelingOrderRequestDto {
  const parsed = createDowelingRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw dowelingValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseUpdateDowelingRequest(body: unknown): UpdateDowelingOrderRequestDto {
  const parsed = updateDowelingRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw dowelingValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseDowelingOrderId(value: unknown): number {
  const parsed = dowelingIdSchema.safeParse(value);
  if (!parsed.success) {
    throw dowelingValidationError(parsed.error);
  }
  return parsed.data;
}

function dowelingValidationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Doweling order payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
