import type { CurrentUser } from '../../../permissions/current-user';
import type { AuditLogListResponseDto } from '../dto/audit.dto';

export interface AuditLogFilters {
  event?: string;
  entityType?: string;
  entityId?: string;
  userId?: number;
  source?: string;
  relatedOrderId?: number;
  relatedClientId?: number;
  relatedPaymentId?: number;
  relatedDeadlineId?: number;
  relatedProductionEventId?: number;
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

export interface AuditLogRepositoryPort {
  list(command: ListAuditCommand): Promise<AuditLogListResponseDto>;
}
