export type DeadlineEntityType = 'order' | 'order_stage' | 'client_action' | 'project' | 'task';
export type DeadlineStatus =
  | 'active'
  | 'paused'
  | 'expired'
  | 'completed_on_time'
  | 'completed_late'
  | 'cancelled'
  | 'superseded';
export type DeadlineSource = 'policy' | 'manual' | 'imported' | 'recalculated' | 'system';
export type DeadlineSeverity = 'info' | 'warning' | 'critical';
export type DeadlinePauseMode = 'pause_without_shift' | 'pause_and_shift_deadline';

export interface DeadlineDto {
  deadlineId: string;
  entityType: DeadlineEntityType;
  entityId: string;
  orderId?: number | null;
  orderWorkshopId?: number | null;
  clientId?: number | null;
  responsibleUserId?: number | null;
  deadlineAt: string;
  status: DeadlineStatus;
  source: DeadlineSource;
  isManuallyOverridden: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeadlineEventDto {
  deadlineEventId: string;
  deadlineId: string;
  eventType: string;
  severity: DeadlineSeverity;
  eventAt: string;
  deadlineAt?: string | null;
  delayMinutes?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface DeadlineListQuery {
  page?: number;
  pageSize?: number;
  sortBy?: 'deadlineAt' | 'status' | 'entityType' | 'orderId' | 'responsibleUserId' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  entityType?: DeadlineEntityType;
  entityId?: string;
  orderId?: number;
  status?: DeadlineStatus;
  responsibleUserId?: number;
  dateFrom?: string;
  dateTo?: string;
  onlyOverdue?: boolean;
}

export interface DeadlineListResponse {
  data: DeadlineDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface DeadlineResponse {
  deadline: DeadlineDto;
}

export interface DeadlineEventsResponse {
  data: DeadlineEventDto[];
}

export interface OrderDeadlinesResponse {
  data: DeadlineDto[];
}

export interface CreateDeadlineRequest {
  entityType: DeadlineEntityType;
  entityId: string;
  orderId?: number | null;
  orderWorkshopId?: number | null;
  clientId?: number | null;
  responsibleUserId?: number | null;
  deadlineAt: string;
  source?: DeadlineSource;
  metadata?: Record<string, unknown>;
}

export interface OverrideDeadlineRequest {
  deadlineAt: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface PauseDeadlineRequest {
  pauseMode: DeadlinePauseMode;
  pauseReason: string;
  notes?: string | null;
}

export interface ResumeDeadlineRequest {
  notes?: string | null;
}

export interface CancelDeadlineRequest {
  reason: string;
}

export interface DeadlineSummaryItem {
  deadlineId: string;
  deadlineAt: string;
  status: DeadlineStatus;
  remainingMinutes: number | null;
  delayMinutes: number | null;
  severity: DeadlineSeverity;
}

export interface OrderStageDeadlineSummary extends DeadlineSummaryItem {
  orderWorkshopId: number | null;
  stageName?: string | null;
}

export interface OrderDeadlineSummary {
  orderId: number;
  finalDeadline: DeadlineSummaryItem | null;
  currentStageDeadline: OrderStageDeadlineSummary | null;
  counts: {
    active: number;
    expired: number;
    completedLate: number;
    completedOnTime: number;
  };
}

export interface DeadlinePolicyDto {
  policyId: string;
  policyCode: string;
  policyName: string;
  scopeType: DeadlineEntityType;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeadlinePolicyListResponse {
  data: DeadlinePolicyDto[];
}

export interface DeadlineSettingsDto {
  reminderEventsEnabled: boolean;
  notifyAssigneeEnabled: boolean;
  notifyManagerEnabled: boolean;
  notifyDepartmentHeadEnabled: boolean;
  setOverdueFlagEnabled: boolean;
  changeOrderStatusEnabled: boolean;
  changeProductionStatusEnabled: boolean;
  escalationEnabled: boolean;
  repeatNotificationsEnabled: boolean;
}

export interface DeadlineSettingsResponse {
  settings: DeadlineSettingsDto;
}

export type UpdateDeadlineSettingsRequest = Partial<DeadlineSettingsDto>;
