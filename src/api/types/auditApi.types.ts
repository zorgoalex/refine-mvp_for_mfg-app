export interface AuditLogEventDto {
  auditId: string;
  event: string;
  entityType: string | null;
  entityId: string | null;
  userId: number | null;
  username: string | null;
  role: string | null;
  source: string | null;
  relatedOrderId: number | null;
  relatedClientId: number | null;
  relatedPaymentId: number | null;
  relatedDeadlineId: number | null;
  relatedProductionEventId: number | null;
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

export interface AuditLogListQuery {
  page?: number;
  pageSize?: number;
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
