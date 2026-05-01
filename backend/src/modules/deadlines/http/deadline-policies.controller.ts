import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { DeadlineCommandService } from '../application/deadline-command.service';
import { DeadlineQueryService } from '../application/deadline-query.service';
import { deadlineEntityTypeSchema, isUuid, metadataSchema } from '../domain/deadline-validation';
import type {
  CreateDeadlinePolicyRequestDto,
  UpdateDeadlinePolicyRequestDto,
} from '../dto/deadline-policy.dto';
import { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

const durationUnitSchema = z
  .enum(['minute', 'hour', 'day', 'working_hour', 'working_day'])
  .nullable()
  .optional();

const createPolicyRequestSchema = z.object({
  policyCode: z.string().trim().min(3).max(100),
  policyName: z.string().trim().min(1).max(255),
  scopeType: deadlineEntityTypeSchema,
  targetType: z.string().trim().max(100).nullable().optional(),
  targetCode: z.string().trim().max(100).nullable().optional(),
  durationValue: z.number().int().positive().nullable().optional(),
  durationUnit: durationUnitSchema,
  startPoint: z.string().trim().max(100).nullable().optional(),
  isEnabled: z.boolean().optional(),
  config: metadataSchema,
});

const updatePolicyRequestSchema = createPolicyRequestSchema
  .omit({ policyCode: true, scopeType: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

@Controller('deadline-policies')
export class DeadlinePoliciesController {
  constructor(
    private readonly commands: DeadlineCommandService,
    private readonly queries: DeadlineQueryService,
    private readonly runtimeConfig: DeadlinesRuntimeConfigService,
  ) {}

  @Get()
  async list(@Req() request: RequestWithCurrentUser) {
    this.assertReadEnabled();

    return this.queries.listPolicies({
      currentUser: this.requireCurrentUser(request),
    });
  }

  @Post()
  async create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    this.assertWriteEnabled();

    return {
      policy: await this.commands.createPolicy({
        currentUser: this.requireCurrentUser(request),
        dto: parseCreateDeadlinePolicyRequest(body),
      }),
    };
  }

  @Patch(':policyId')
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('policyId') policyIdParam: string,
    @Body() body: unknown,
  ) {
    this.assertWriteEnabled();

    return {
      policy: await this.commands.updatePolicy({
        currentUser: this.requireCurrentUser(request),
        policyId: parsePolicyId(policyIdParam),
        dto: parseUpdateDeadlinePolicyRequest(body),
      }),
    };
  }

  private assertReadEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadlines API is disabled', {
        feature: 'deadlines',
      });
    }
  }

  private assertWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();
    if (!flags.deadlinesEnabled) {
      throw new ApiError(503, 'DEADLINES_DISABLED', 'Deadlines API is disabled', {
        feature: 'deadlines',
      });
    }
    if (flags.deadlinesReadOnly) {
      throw new ApiError(503, 'DEADLINES_READ_ONLY', 'Deadline policies are read-only', {
        feature: 'deadlines',
        mode: 'read_only',
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

export function parsePolicyId(value: string): string {
  if (!isUuid(value)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid policy id', { field: 'policyId' });
  }

  return value;
}

export function parseCreateDeadlinePolicyRequest(body: unknown): CreateDeadlinePolicyRequestDto {
  return parseRequestBody(createPolicyRequestSchema, body);
}

export function parseUpdateDeadlinePolicyRequest(body: unknown): UpdateDeadlinePolicyRequestDto {
  return parseRequestBody(updatePolicyRequestSchema, body);
}

function parseRequestBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Deadline policy validation failed', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}
