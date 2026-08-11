import type { CurrentUser } from '../../../permissions/current-user';
import type {
  AuditFilterOptionsResponseDto,
  AuditLogListResponseDto,
  AuditOrderFilterOptionsResponseDto,
  AuditParticipantFilterOptionsResponseDto,
} from '../dto/audit.dto';

export type AuditLogScope = 'all' | 'business';

export interface AuditLogFilters {
  event?: string;
  events?: string[];
  entityType?: string;
  entityId?: string;
  userId?: number;
  orderIds?: number[];
  participantUserIds?: number[];
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
  scope?: AuditLogScope;
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
  scope?: AuditLogScope;
}

export interface AuditLookupQuery {
  ids?: number[];
  search?: string;
  limit: number;
}

export interface AuditLookupOptionsCommand {
  currentUser: CurrentUser | undefined;
  requestId: string;
  query: AuditLookupQuery;
}

export interface AuditLogRepositoryPort {
  list(command: ListAuditCommand): Promise<AuditLogListResponseDto>;
  filterOptions(command: AuditFilterOptionsCommand): Promise<AuditFilterOptionsResponseDto>;
  orderOptions(command: AuditLookupOptionsCommand): Promise<AuditOrderFilterOptionsResponseDto>;
  participantOptions(command: AuditLookupOptionsCommand): Promise<AuditParticipantFilterOptionsResponseDto>;
}
