import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
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

@Controller('payments')
export class PaymentsController {
  constructor(
    @Inject(PaymentService)
    private readonly payments: PaymentService,
    @Inject(PaymentsRuntimeConfigService)
    private readonly runtimeConfig: PaymentsRuntimeConfigService,
  ) {}

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

