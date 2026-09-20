export interface AuditRelatedEntity {
  entityType: string;
  entityId: number;
  entityName?: string | null;
  detailNumber?: number | null;
}

export interface AuditLogEventDto {
  bitrix?: { label: string; direction: string; category: string; outcome: string; refs: Array<{ type: string; id: string; identitySource: string }>; currentRequestOrderId: number | null };
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

export interface AuditOrderFilterOption {
  orderId: number;
  orderName: string;
}

export interface AuditParticipantFilterOption {
  userId: number;
  username: string;
  role: string | null;
}

export interface AuditOrderFilterOptionsResponse {
  data: AuditOrderFilterOption[];
  requestId: string;
}

export interface AuditParticipantFilterOptionsResponse {
  data: AuditParticipantFilterOption[];
  requestId: string;
}

export interface AuditLookupOptionsQuery {
  ids?: number[];
  search?: string;
  limit?: number;
}

export interface AuditLogListQuery {
  excludeBitrix24?: boolean;
  bitrixDirection?: 'forward' | 'reverse' | 'widget' | 'settings' | 'other';
  bitrixCategory?: 'client' | 'order' | 'payment' | 'settings' | 'processing' | 'other';
  bitrixOutcome?: 'success' | 'error' | 'conflict' | 'attention' | 'started' | 'skipped' | 'unknown';
  bitrixReconcile?: 'exclude' | 'only';
  bitrixObject?: 'contact' | 'company' | 'deal' | 'payment';
  bitrixId?: string;
  page?: number;
  pageSize?: number;
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
  scope?: 'all' | 'business' | 'bitrix24';
}

export interface BitrixAuditStatus {
  stageQueue?: Array<{status:string;count:number}>;
  fetchedAt: string;
  data: Array<{ direction: 'forward' | 'reverse'; enabled: boolean; owner: string; dryRun: boolean; pending: number; processing: number; failed: number; dead: number; oldestPendingAt: string | null; lastProcessedAt: string | null }>;
}
export interface BitrixQueueQuery {
  queueType?: 'entity' | 'order_stage';
  direction: 'forward' | 'reverse'; status?: string; orderId?: number;
  entityType?: string; entityId?: string; bitrixObject?: string; bitrixId?: string;
  page: number; pageSize: number;
}
export interface BitrixQueueRow {
  queueType?: 'entity' | 'order_stage';
  id: string; queueId: string; direction: string; event: string; entityType: string | null; entityId: string | null;
  orderId: string | null; orderName: string | null; bitrixObject: string | null; bitrixId: string | null;
  status: string; attempts: number; createdAt: string; processedAt: string | null; nextAttemptAt: string | null;
  error: string | null; errorSource: string | null;
}
export interface BitrixQueueResponse { data: BitrixQueueRow[]; pagination: { page: number; pageSize: number; total: number } }
