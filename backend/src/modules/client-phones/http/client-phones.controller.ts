import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ClientPhoneService } from '../application/client-phone.service';
import type {
  ClientPhoneResponseDto,
  CreateClientPhoneRequestDto,
  DeleteClientPhoneRequestDto,
  DeleteClientPhoneResponseDto,
  UpdateClientPhoneRequestDto,
} from '../dto/client-phone.dto';
import { ClientPhonesRuntimeConfigService } from './client-phones-runtime-config.service';

const phoneTypeSchema = z.enum(['mobile', 'work', 'home', 'fax']);
const phoneNumberSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^\+?[0-9\s\-\(\)]{7,20}$/, 'Invalid phone number format');
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const nullableUuidSchema = z
  .union([z.string().trim().uuid(), z.literal('').transform(() => null), z.null()])
  .optional()
  .transform((value) => value ?? null);
const optionalNullableUuidSchema = z.union([
  z.string().trim().uuid(),
  z.literal('').transform(() => null),
  z.null(),
]);

const createClientPhoneRequestSchema = z.object({
  clientId: z.number().int().positive(),
  phoneNumber: phoneNumberSchema,
  phoneType: phoneTypeSchema.optional().default('mobile'),
  isPrimary: z.boolean().optional().default(false),
  refKey1c: nullableUuidSchema,
  idempotencyKey: idempotencyKeySchema,
});

const updateClientPhoneRequestSchema = z
  .object({
    clientId: z.number().int().positive().optional(),
    phoneNumber: phoneNumberSchema.optional(),
    phoneType: phoneTypeSchema.optional(),
    isPrimary: z.boolean().optional(),
    refKey1c: optionalNullableUuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine(
    (value) =>
      Object.prototype.hasOwnProperty.call(value, 'phoneNumber') ||
      Object.prototype.hasOwnProperty.call(value, 'phoneType') ||
      Object.prototype.hasOwnProperty.call(value, 'isPrimary') ||
      Object.prototype.hasOwnProperty.call(value, 'refKey1c'),
    { message: 'At least one mutable field must be provided' },
  );

const deleteClientPhoneRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

@Controller('client-phones')
export class ClientPhonesController {
  constructor(
    @Inject(ClientPhoneService)
    private readonly clientPhones: ClientPhoneService,
    @Inject(ClientPhonesRuntimeConfigService)
    private readonly runtimeConfig: ClientPhonesRuntimeConfigService,
  ) {}

  @Post()
  async create(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<ClientPhoneResponseDto> {
    this.assertClientPhonesEnabled();

    return this.clientPhones.create({
      currentUser: this.requireCurrentUser(request),
      dto: parseCreateClientPhoneRequest(body),
      requestId: request.requestId,
    });
  }

  @Patch(':phoneId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('phoneId') phoneIdParam: string,
    @Body() body: unknown,
  ): Promise<ClientPhoneResponseDto> {
    this.assertClientPhonesEnabled();

    return this.clientPhones.update({
      currentUser: this.requireCurrentUser(request),
      phoneId: parseClientPhoneId(phoneIdParam),
      dto: parseUpdateClientPhoneRequest(body),
      requestId: request.requestId,
    });
  }

  @Delete(':phoneId')
  @HttpCode(200)
  async delete(
    @Req() request: RequestWithCurrentUser,
    @Param('phoneId') phoneIdParam: string,
    @Body() body: unknown,
  ): Promise<DeleteClientPhoneResponseDto> {
    this.assertClientPhonesEnabled();

    return this.clientPhones.delete({
      currentUser: this.requireCurrentUser(request),
      phoneId: parseClientPhoneId(phoneIdParam),
      dto: parseDeleteClientPhoneRequest(body),
      requestId: request.requestId,
    });
  }

  private assertClientPhonesEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().clientPhonesEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Client phones API is disabled', {
        feature: 'clientPhones',
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

export function parseClientPhoneId(value: string): number {
  const phoneId = Number(value);

  if (!Number.isInteger(phoneId) || phoneId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid client phone id', {
      field: 'phoneId',
    });
  }

  return phoneId;
}

export function parseCreateClientPhoneRequest(body: unknown): CreateClientPhoneRequestDto {
  const parsed = createClientPhoneRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw clientPhoneValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseUpdateClientPhoneRequest(body: unknown): UpdateClientPhoneRequestDto {
  const parsed = updateClientPhoneRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw clientPhoneValidationError(parsed.error);
  }

  return parsed.data;
}

export function parseDeleteClientPhoneRequest(body: unknown): DeleteClientPhoneRequestDto {
  const parsed = deleteClientPhoneRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw clientPhoneValidationError(parsed.error);
  }

  return parsed.data;
}

function clientPhoneValidationError(error: z.ZodError): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Client phone payload validation failed', {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  });
}
