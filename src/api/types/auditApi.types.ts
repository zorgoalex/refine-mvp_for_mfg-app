export interface AuditRelatedEntity {
  entityType: string;
  entityId: number;
  entityName?: string | null;
  detailNumber?: number | null;
}

export interface AuditLogEventDto {
  auditId: string;
  event: string;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  entityDetailNumber: number | null;
  userId: number | null;
  username: string | null;
  role: string | null;
  source: string | null;
  relatedOrderId: number | null;
  relatedOrderName: string | null;
  relatedClientId: number | null;
  relatedClientName: string | null;
  relatedPaymentId: number | null;
  relatedDeadlineId: number | null;
  relatedProductionEventId: number | null;
  relatedUserId: number | null;
  relatedEntities: AuditRelatedEntity[];
  statusField: string | null;
  statusId: number | null;
  statusName: string | null;
  statusCode: string | null;
  stageCode: string | null;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  before: unknown;
  after: unknown;
  diff: unknown;
  metadata: unknown;
  createdAt: string;
}

export interface AuditLogPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AuditLogListResponse {
  data: AuditLogEventDto[];
  pagination: AuditLogPagination;
  requestId: string;
}

export interface AuditUserFilterOption {
  userId: number;
  username: string | null;
  role: string | null;
}

export interface AuditRelatedEntityFilterOption {
  entityType: string;
  entityId: number;
  entityName?: string | null;
  detailNumber?: number | null;
}

export interface AuditFilterOptions {
  events: string[];
  entityTypes: string[];
  entityIds: string[];
  users: AuditUserFilterOption[];
  roles: string[];
  sources: string[];
  relatedOrderIds: number[];
  relatedClientIds: number[];
  relatedPaymentIds: number[];
  relatedDeadlineIds: number[];
  relatedProductionEventIds: number[];
  relatedUserIds: number[];
  relatedEntityTypes: string[];
  relatedEntities: AuditRelatedEntityFilterOption[];
  requestIds: string[];
}

export interface AuditFilterOptionsResponse {
  data: AuditFilterOptions;
  requestId: string;
}

export interface AuditLogListQuery {
  page?: number;
  pageSize?: number;
  event?: string;
  entityType?: string;
  entityId?: string;
  userId?: number;
  role?: string;
  source?: string;
  relatedOrderId?: number;
  relatedClientId?: number;
  relatedPaymentId?: number;
  relatedDeadlineId?: number;
  relatedProductionEventId?: number;
  relatedUserId?: number;
  relatedEntityType?: string;
  relatedEntityId?: number;
  requestId?: string;
  createdFrom?: string;
  createdTo?: string;
}
