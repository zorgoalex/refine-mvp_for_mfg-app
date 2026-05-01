import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from './current-user';
import type { PermissionName } from './permissions';
import { PermissionsService } from './permissions.service';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<readonly PermissionName[]>(
      REQUIRED_PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions?.length) {
      return true;
    }

    const user = context.switchToHttp().getRequest<RequestWithCurrentUser>().user;

    if (!user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    if (!this.hasRequiredPermissions(user, requiredPermissions)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions,
      });
    }

    return true;
  }

  private hasRequiredPermissions(
    user: CurrentUser,
    requiredPermissions: readonly PermissionName[],
  ): boolean {
    return requiredPermissions.every((permission) =>
      this.permissionsService.canUser(user, permission),
    );
  }
}
