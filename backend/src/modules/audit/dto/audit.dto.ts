export interface AuditPaginationDto {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

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
  relatedUserId: number | null;
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

export interface AuditLogListResponseDto {
  data: AuditLogEventDto[];
  pagination: AuditPaginationDto;
  requestId: string;
}
