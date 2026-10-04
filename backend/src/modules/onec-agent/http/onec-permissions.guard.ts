import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';
import { ONEC_ADMIN_AUDIT_SOURCE } from '../application/onec-audit';

/**
 * Admin API permission gate: literal membership in the user's permissions;
 * `onec.view` is implied by `onec.manage` or `onec.commands.send`, matching
 * the frontend gate. Denials are audited.
 */
@Injectable()
export class OnecPermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<readonly PermissionName[]>(REQUIRED_PERMISSIONS_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<RequestWithCurrentUser & { method?: string; originalUrl?: string }>();
    const user = request.user;
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const has = (permission: PermissionName) =>
      this.permissions.canUser(user, permission) ||
      (permission === 'onec.view' &&
        (this.permissions.canUser(user, 'onec.manage') || this.permissions.canUser(user, 'onec.commands.send')));
    if (required.every(has)) return true;
    const requestId = request.requestId ?? `onec-denied-${Date.now()}`;
    await auditService.recordDenied(this.database, {
      event: 'onec.permission_denied',
      entityType: 'onec_permission',
      entityId: `${request.method ?? 'request'}:${(request.originalUrl ?? 'onec').split('?')[0]}`,
      actorUserId: user.id,
      actorUsername: user.username,
      actorRole: user.role,
      requestId,
      source: ONEC_ADMIN_AUDIT_SOURCE,
      reason: 'missing_permission',
      requiredPermissions: required,
      metadata: { correlationId: requestId },
    });
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', { requiredPermissions: required });
  }
}
