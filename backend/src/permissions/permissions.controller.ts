import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../common/errors/api-error';
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
  @Put('roles-matrix')
  async updateRolesMatrix(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<RolesMatrixDto> {
    const parsed = parseUpdateMatrix(body);
    return this.permissions.updateRolesMatrix(
      requireCurrentUser(request),
      parsed,
      request.requestId,
    );
  }

  @ApiOperation({ operationId: 'resetRolePermissionsToDefaults', summary: 'Reset a role to default permissions' })
  @ApiParam({ name: 'roleId', type: Number })
  @ApiResponse({ status: 200, description: 'Updated role permissions matrix' })
  @Post('roles/:roleId/reset-to-defaults')
  @HttpCode(200)
  async resetRoleToDefaults(
    @Req() request: RequestWithCurrentUser,
    @Param('roleId') roleIdParam: string,
  ): Promise<RolesMatrixDto> {
    return this.permissions.resetRoleToDefaults(
      requireCurrentUser(request),
      parseRoleId(roleIdParam),
      request.requestId,
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
