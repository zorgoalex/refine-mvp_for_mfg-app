import type { CurrentUser } from '../../../permissions/current-user';
import type {
  AuditFilterOptionsResponseDto,
  AuditLogListResponseDto,
  AuditOrderFilterOptionsResponseDto,
  AuditParticipantFilterOptionsResponseDto,
} from '../dto/audit.dto';

export type AuditLogScope = 'all' | 'business' | 'bitrix24';

export interface AuditLogFilters {
  excludeBitrix24?: boolean;
  bitrixDirection?: 'forward' | 'reverse' | 'widget' | 'settings' | 'other';
  bitrixCategory?: 'client' | 'order' | 'payment' | 'settings' | 'processing' | 'other';
  bitrixOutcome?: 'success' | 'error' | 'conflict' | 'attention' | 'started' | 'skipped' | 'unknown';
  bitrixReconcile?: 'exclude' | 'only';
  bitrixObject?: 'contact' | 'company' | 'deal' | 'payment';
  bitrixId?: string;
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
  excludeBitrix24?: boolean;
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
