import type { CurrentUser } from '../../../permissions/current-user';
import type { AuditFilterOptionsResponseDto, AuditLogListResponseDto } from '../dto/audit.dto';

export interface AuditLogFilters {
  event?: string;
  entityType?: string;
  entityId?: string;
  userId?: number;
  role?: string;
  source?: string;
  relatedOrderId?: number;
  relatedUserId?: number;
  relatedClientId?: number;
  relatedPaymentId?: number;
  relatedDeadlineId?: number;
  relatedProductionEventId?: number;
  relatedEntityType?: string;
  relatedEntityId?: number;
  requestId?: string;
  createdFrom?: string;
  createdTo?: string;
}

export interface ListAuditCommand {
  currentUser: CurrentUser | undefined;
  filters: AuditLogFilters;
  page: number;
  pageSize: number;
  requestId: string;
}

export interface AuditFilterOptionsCommand {
  currentUser: CurrentUser | undefined;
  requestId: string;
}

export interface AuditLogRepositoryPort {
  list(command: ListAuditCommand): Promise<AuditLogListResponseDto>;
  filterOptions(command: AuditFilterOptionsCommand): Promise<AuditFilterOptionsResponseDto>;
}
