import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { AuditLogListResponseDto } from '../dto/audit.dto';
import type { AuditLogRepositoryPort, ListAuditCommand } from './audit-query.types';

export interface AuditQueryServicePorts {
  repository: AuditLogRepositoryPort;
  permissions?: PermissionsService;
}

export class AuditQueryService {
  private readonly permissions: PermissionsService;
  constructor(private readonly ports: AuditQueryServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListAuditCommand): Promise<AuditLogListResponseDto> {
    if (!command.currentUser) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    if (!this.permissions.canUser(command.currentUser, 'audit.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['audit.view'],
      });
    }
    return this.ports.repository.list(command);
  }
}
