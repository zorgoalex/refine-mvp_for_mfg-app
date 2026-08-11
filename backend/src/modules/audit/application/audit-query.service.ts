import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  AuditFilterOptionsResponseDto,
  AuditLogListResponseDto,
  AuditOrderFilterOptionsResponseDto,
  AuditParticipantFilterOptionsResponseDto,
} from '../dto/audit.dto';
import type {
  AuditFilterOptionsCommand,
  AuditLogRepositoryPort,
  AuditLookupOptionsCommand,
  ListAuditCommand,
} from './audit-query.types';

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
    this.assertCanViewAudit(command.currentUser);
    return this.ports.repository.list(command);
  }

  async filterOptions(command: AuditFilterOptionsCommand): Promise<AuditFilterOptionsResponseDto> {
    this.assertCanViewAudit(command.currentUser);
    return this.ports.repository.filterOptions(command);
  }

  async orderOptions(command: AuditLookupOptionsCommand): Promise<AuditOrderFilterOptionsResponseDto> {
    this.assertCanViewAudit(command.currentUser);
    return this.ports.repository.orderOptions(command);
  }

  async participantOptions(command: AuditLookupOptionsCommand): Promise<AuditParticipantFilterOptionsResponseDto> {
    this.assertCanViewAudit(command.currentUser);
    return this.ports.repository.participantOptions(command);
  }

  private assertCanViewAudit(currentUser: ListAuditCommand['currentUser']): void {
    if (!currentUser) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    if (!this.permissions.canUser(currentUser, 'audit.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['audit.view'],
      });
    }
  }
}
