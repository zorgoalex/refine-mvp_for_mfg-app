import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PaymentService } from '../application/payment.service';
import type {
  CreatePaymentRequestDto,
  DeletePaymentResponseDto,
  PaymentResponseDto,
  UpdatePaymentRequestDto,
} from '../dto/payment.dto';
import { PaymentsRuntimeConfigService } from './payments-runtime-config.service';

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'paymentDate must be YYYY-MM-DD');
const nullableTextSchema = z.string().trim().max(1000).nullable().optional();
const nullableUuidSchema = z.string().uuid().nullable().optional();

const createPaymentRequestSchema = z.object({
  orderId: z.number().int().positive(),
  typePaidId: z.number().int().positive(),
  amount: z.number().positive(),
  paymentDate: dateOnlySchema,
  notes: nullableTextSchema,
  refKey1c: nullableUuidSchema,
});

const updatePaymentRequestSchema = z
  .object({
    orderId: z.number().int().positive().optional(),
    typePaidId: z.number().int().positive().optional(),
    amount: z.number().positive().optional(),
    paymentDate: dateOnlySchema.optional(),
    notes: nullableTextSchema,
    refKey1c: nullableUuidSchema,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

const paymentOrderSummarySwaggerSchema = {
  type: 'object',
  required: ['orderId', 'paidAmount', 'debtAmount', 'paymentDate', 'paymentStatusId', 'version'],
  properties: {
    orderId: { type: 'integer' },
    paidAmount: { type: 'number' },
    debtAmount: { type: 'number' },
    paymentDate: { type: 'string', format: 'date', nullable: true },
    paymentStatusId: { type: 'integer' },
    version: { type: 'integer' },
  },
} as const;

const paymentSwaggerSchema = {
  type: 'object',
  required: ['paymentId', 'orderId', 'typePaidId', 'amount', 'paymentDate', 'notes', 'refKey1c', 'createdBy', 'editedBy', 'createdAt', 'updatedAt'],
  properties: {
    paymentId: { type: 'integer' },
    orderId: { type: 'integer' },
    typePaidId: { type: 'integer' },
    amount: { type: 'number' },
    paymentDate: { type: 'string', format: 'date' },
    notes: { type: 'string', nullable: true, maxLength: 1000 },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
    createdBy: { type: 'integer', nullable: true },
    editedBy: { type: 'integer', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const createPaymentRequestSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'typePaidId', 'amount', 'paymentDate'],
  properties: {
    orderId: { type: 'integer' },
    typePaidId: { type: 'integer' },
    amount: { type: 'number', exclusiveMinimum: 0 },
    paymentDate: { type: 'string', format: 'date' },
    notes: { type: 'string', nullable: true, maxLength: 1000 },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
  },
} as const;

const updatePaymentRequestSwaggerSchema = {
  type: 'object',
  minProperties: 1,
  properties: {
    orderId: { type: 'integer' },
    typePaidId: { type: 'integer' },
    amount: { type: 'number', exclusiveMinimum: 0 },
    paymentDate: { type: 'string', format: 'date' },
    notes: { type: 'string', nullable: true, maxLength: 1000 },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
  },
} as const;

const paymentResponseSwaggerSchema = {
  type: 'object',
  required: ['payment', 'order'],
  properties: {
    payment: paymentSwaggerSchema,
    order: paymentOrderSummarySwaggerSchema,
  },
} as const;

const deletePaymentResponseSwaggerSchema = {
  type: 'object',
  required: ['paymentId', 'order', 'deleted'],
  properties: {
    paymentId: { type: 'integer' },
    order: paymentOrderSummarySwaggerSchema,
    deleted: { type: 'boolean', enum: [true] },
  },
} as const;

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(
    @Inject(PaymentService)
    private readonly payments: PaymentService,
    @Inject(PaymentsRuntimeConfigService)
    private readonly runtimeConfig: PaymentsRuntimeConfigService,
  ) {}

  @ApiBody({ schema: swaggerSchema(createPaymentRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created payment', schema: swaggerSchema(paymentResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 422, description: 'Invalid payment payload' })
  @ApiResponse({ status: 503, description: 'Payments API is disabled' })
  @ApiOperation({ operationId: 'createPayment', summary: 'Create a payment' })
  @Post()
  async create(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<PaymentResponseDto> {
    this.assertPaymentsEnabled();

    const currentUser = this.requireCurrentUser(request);
    const result = await this.payments.create({
      currentUser,
      dto: parseCreatePaymentRequest(body),
      requestId: request.requestId,
    });

    return result;
  }

  @ApiParam({ name: 'paymentId', type: Number, description: 'Payment ID' })
  @ApiBody({ schema: swaggerSchema(updatePaymentRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Updated payment', schema: swaggerSchema(paymentResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid payment ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 422, description: 'Invalid payment payload' })
  @ApiResponse({ status: 503, description: 'Payments API is disabled' })
  @ApiOperation({ operationId: 'updatePayment', summary: 'Update a payment' })
  @Patch(':paymentId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('paymentId') paymentIdParam: string,
    @Body() body: unknown,
  ): Promise<PaymentResponseDto> {
    this.assertPaymentsEnabled();

    const currentUser = this.requireCurrentUser(request);
    const result = await this.payments.update({
      currentUser,
      paymentId: parsePaymentId(paymentIdParam),
      dto: parseUpdatePaymentRequest(body),
      requestId: request.requestId,
    });

    return result;
  }

  @ApiParam({ name: 'paymentId', type: Number, description: 'Payment ID' })
  @ApiResponse({ status: 200, description: 'Deleted payment', schema: swaggerSchema(deletePaymentResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Invalid payment ID' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 503, description: 'Payments API is disabled' })
  @ApiOperation({ operationId: 'deletePayment', summary: 'Delete a payment' })
  @Delete(':paymentId')
  @HttpCode(200)
  async delete(
    @Req() request: RequestWithCurrentUser,
    @Param('paymentId') paymentIdParam: string,
  ): Promise<DeletePaymentResponseDto> {
    this.assertPaymentsEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.payments.delete({
      currentUser,
      paymentId: parsePaymentId(paymentIdParam),
      requestId: request.requestId,
    });
  }

  private assertPaymentsEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().paymentsEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Payments API is disabled', {
        feature: 'payments',
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

export function parsePaymentId(value: string): number {
  const paymentId = Number(value);

  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid payment id', {
      field: 'paymentId',
    });
  }

  return paymentId;
}

export function parseCreatePaymentRequest(body: unknown): CreatePaymentRequestDto {
  const parsed = createPaymentRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw paymentValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseUpdatePaymentRequest(body: unknown): UpdatePaymentRequestDto {
  const parsed = updatePaymentRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw paymentValidationError(parsed.error);
  }

  return parsed.data;
}

function paymentValidationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Payment payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
