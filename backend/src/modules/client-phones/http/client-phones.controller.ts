import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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

const phoneTypeSwaggerSchema = { type: 'string', enum: ['mobile', 'work', 'home', 'fax'] } as const;

const clientPhoneSwaggerSchema = {
  type: 'object',
  required: ['phoneId', 'clientId', 'phoneNumber', 'phoneType', 'isPrimary', 'refKey1c', 'createdBy', 'editedBy', 'createdAt', 'updatedAt'],
  properties: {
    phoneId: { type: 'integer' },
    clientId: { type: 'integer' },
    phoneNumber: { type: 'string', minLength: 7, maxLength: 20 },
    phoneType: phoneTypeSwaggerSchema,
    isPrimary: { type: 'boolean' },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
    createdBy: { type: 'integer', nullable: true },
    editedBy: { type: 'integer', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const createClientPhoneRequestSwaggerSchema = {
  type: 'object',
  required: ['clientId', 'phoneNumber', 'idempotencyKey'],
  properties: {
    clientId: { type: 'integer' },
    phoneNumber: { type: 'string', minLength: 7, maxLength: 20 },
    phoneType: { ...phoneTypeSwaggerSchema, default: 'mobile' },
    isPrimary: { type: 'boolean', default: false },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const updateClientPhoneRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey'],
  properties: {
    clientId: { type: 'integer' },
    phoneNumber: { type: 'string', minLength: 7, maxLength: 20 },
    phoneType: phoneTypeSwaggerSchema,
    isPrimary: { type: 'boolean' },
    refKey1c: { type: 'string', format: 'uuid', nullable: true },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const deleteClientPhoneRequestSwaggerSchema = {
  type: 'object',
  required: ['idempotencyKey'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const clientPhoneResponseSwaggerSchema = {
  type: 'object',
  required: ['phone', 'requestId'],
  properties: {
    phone: clientPhoneSwaggerSchema,
    demotedPhoneIds: { type: 'array', items: { type: 'integer' } },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

const deleteClientPhoneResponseSwaggerSchema = {
  type: 'object',
  required: ['phoneId', 'clientId', 'deleted', 'requestId'],
  properties: {
    phoneId: { type: 'integer' },
    clientId: { type: 'integer' },
    deleted: { type: 'boolean', enum: [true] },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

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
