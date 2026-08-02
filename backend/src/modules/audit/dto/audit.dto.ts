export interface AuditRelatedEntityDto {
  entityType: string;
  entityId: number;
  entityName?: string | null;
  detailNumber?: number | null;
}

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
  relatedEntities: AuditRelatedEntityDto[];
  createdAt: string;
}

export interface AuditLogListResponseDto {
  data: AuditLogEventDto[];
  pagination: AuditPaginationDto;
  requestId: string;
}

export interface AuditUserFilterOptionDto {
  userId: number;
  username: string | null;
  role: string | null;
}

export interface AuditRelatedEntityFilterOptionDto {
  entityType: string;
  entityId: number;
  entityName?: string | null;
  detailNumber?: number | null;
}

export interface AuditFilterOptionsDto {
  events: string[];
  entityTypes: string[];
  entityIds: string[];
  users: AuditUserFilterOptionDto[];
  roles: string[];
  sources: string[];
  relatedOrderIds: number[];
  relatedClientIds: number[];
  relatedPaymentIds: number[];
  relatedDeadlineIds: number[];
  relatedProductionEventIds: number[];
  relatedUserIds: number[];
  relatedEntityTypes: string[];
  relatedEntities: AuditRelatedEntityFilterOptionDto[];
  requestIds: string[];
}

export interface AuditFilterOptionsResponseDto {
  data: AuditFilterOptionsDto;
  requestId: string;
}
