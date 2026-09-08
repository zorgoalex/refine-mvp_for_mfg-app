import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { auditService } from "../../common/audit/audit.service";
import { ApiError } from "../../common/errors/api-error";
import { DatabaseService } from "../../database/database.service";
import type { RequestWithCurrentUser } from "../../permissions/current-user";
import type { PermissionName } from "../../permissions/permissions";
import { PermissionsService } from "../../permissions/permissions.service";
import { REQUIRED_PERMISSIONS_METADATA_KEY } from "../../permissions/require-permissions.decorator";

@Injectable()
export class WhatsAppPermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionsService)
    private readonly permissions: PermissionsService,
    @Inject(DatabaseService) private readonly database: DatabaseService
  ) {}
  async canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<
      readonly PermissionName[]
    >(REQUIRED_PERMISSIONS_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const request = context
      .switchToHttp()
      .getRequest<
        RequestWithCurrentUser & { method?: string; originalUrl?: string }
      >();
    if (!request.user)
      throw new ApiError(401, "AUTH_REQUIRED", "Authentication required");
    if (
      required.every((permission) =>
        this.hasPermission(request.user!, permission)
      )
    )
      return true;
    const requestId = request.requestId ?? `whatsapp-denied-${Date.now()}`;
    await auditService.recordDenied(this.database, {
      event: "whatsapp.permission_denied",
      entityType: "whatsapp_permission",
      entityId: `${request.method ?? "request"}:${
        request.originalUrl ?? "whatsapp"
      }`,
      actorUserId: request.user.id,
      actorUsername: request.user.username,
      actorRole: request.user.role,
      requestId,
      source: "erp_whatsapp_admin",
      reason: "missing_permission",
      requiredPermissions: required,
      metadata: { correlationId: requestId },
    });
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      "Недостаточно прав для выполнения действия",
      { requiredPermissions: required }
    );
  }
  private hasPermission(
    user: NonNullable<RequestWithCurrentUser["user"]>,
    permission: PermissionName
  ) {
    return (
      this.permissions.canUser(user, permission) ||
      (permission === "whatsapp.view" &&
        this.permissions.canUser(user, "whatsapp.manage"))
    );
  }
}
