import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../common/errors/api-error';
import { parseIdempotencyKey } from './authorization-idempotency';
import type { RequestWithCurrentUser } from './current-user';
import {
  ALLOWED_SCOPE_VALUES,
  PermissionsService,
  ROLE_POLICY_SCOPE_KEYS,
  type RolesMatrixDto,
  type UpdateRolesMatrixRequest,
} from './permissions.service';

const scopeValueSchema = z.enum(['all', 'own', 'assigned', 'none']);
const updateMatrixSchema = z.object({
  version: z.number().int().positive(),
  rolePermissions: z.record(z.string(), z.record(z.string(), z.boolean())),
  roleScopes: z.record(z.string(), z.partialRecord(z.enum(ROLE_POLICY_SCOPE_KEYS), scopeValueSchema)),
  confirmDangerous: z.boolean().optional(),
});

/** Transitional (access groups plan R5 §5.3): optional for the matrix; with a key the repeat replays the stored answer. */
const optionalIdempotencyHeader = {
  name: 'Idempotency-Key',
  required: false,
  description: 'Optional; a repeat with the same key and body returns the stored response, another body — 409',
  schema: { type: 'string', minLength: 8, maxLength: 200 },
} as const;

@ApiTags('Permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(
    @Inject(PermissionsService)
    private readonly permissions: PermissionsService,
  ) {}

  @ApiOperation({ operationId: 'getRolesMatrix', summary: 'Get role permissions matrix' })
  @ApiResponse({ status: 200, description: 'Role permissions matrix' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @Get('roles-matrix')
  async getRolesMatrix(@Req() request: RequestWithCurrentUser): Promise<RolesMatrixDto> {
    const currentUser = requireCurrentUser(request);
    if (
      !this.permissions.canUser(currentUser, 'permissions.manage') &&
      !this.permissions.canUser(currentUser, 'system.superadmin')
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['permissions.manage'],
      });
    }
    return this.permissions.getRolesMatrix();
  }

  @ApiOperation({ operationId: 'updateRolesMatrix', summary: 'Update role permissions matrix' })
  @ApiResponse({ status: 200, description: 'Updated role permissions matrix' })
  @ApiResponse({ status: 409, description: 'Stale permissions matrix version or lockout denied' })
  @ApiHeader(optionalIdempotencyHeader)
  @Put('roles-matrix')
  async updateRolesMatrix(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string | string[],
  ): Promise<RolesMatrixDto> {
    const currentUser = requireCurrentUser(request);
    const parsed = parseUpdateMatrix(body);
    return this.permissions.updateRolesMatrix(
      currentUser,
      parsed,
      request.requestId,
      parseIdempotencyKey(idempotencyKey, false),
    );
  }

  @ApiOperation({ operationId: 'resetRolePermissionsToDefaults', summary: 'Reset a role to default permissions' })
  @ApiParam({ name: 'roleId', type: Number })
  @ApiResponse({ status: 200, description: 'Updated role permissions matrix' })
  @ApiHeader(optionalIdempotencyHeader)
  @Post('roles/:roleId/reset-to-defaults')
  @HttpCode(200)
  async resetRoleToDefaults(
    @Req() request: RequestWithCurrentUser,
    @Param('roleId') roleIdParam: string,
    @Headers('idempotency-key') idempotencyKey?: string | string[],
  ): Promise<RolesMatrixDto> {
    const currentUser = requireCurrentUser(request);
    return this.permissions.resetRoleToDefaults(
      currentUser,
      parseRoleId(roleIdParam),
      request.requestId,
      parseIdempotencyKey(idempotencyKey, false),
    );
  }
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}

function parseUpdateMatrix(body: unknown): UpdateRolesMatrixRequest {
  const parsed = updateMatrixSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid permissions matrix payload', {
      errors: parsed.error.issues,
      scopeKeys: ROLE_POLICY_SCOPE_KEYS,
      allowedScopeValues: ALLOWED_SCOPE_VALUES,
    });
  }
  return parsed.data;
}

function parseRoleId(value: string): number {
  const roleId = Number(value);
  if (!Number.isInteger(roleId) || roleId <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid role id');
  }
  return roleId;
}
