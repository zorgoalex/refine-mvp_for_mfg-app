import type { DeadlineEventSeverity, DeadlineEventType } from '../domain/deadline-events';
import type { DeadlineEntityType, DeadlinePauseMode, DeadlineSource } from '../domain/deadline-validation';
import type { DeadlineStatus } from '../domain/deadline-status';

export interface DeadlineInstanceDto {
  deadlineId: string;
  policyId?: string | null;
  policyVersionId?: string | null;
  entityType: DeadlineEntityType;
  entityId: string;
  parentEntityType?: string | null;
  parentEntityId?: string | null;
  orderId?: number | null;
  orderWorkshopId?: number | null;
  clientId?: number | null;
  responsibleUserId?: number | null;
  deadlineAt: string;
  status: DeadlineStatus;
  source: DeadlineSource;
  isManuallyOverridden: boolean;
  policySnapshot?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  startedAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeadlineEventDto {
  deadlineEventId: string;
  deadlineId: string;
  eventType: DeadlineEventType;
  severity: DeadlineEventSeverity;
  entityType: DeadlineEntityType;
  entityId: string;
  orderId?: number | null;
  orderWorkshopId?: number | null;
  clientId?: number | null;
  deadlineAt?: string | null;
  eventAt: string;
  delayMinutes?: number | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface DeadlineListResponseDto {
  data: DeadlineInstanceDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface DeadlineEventsResponseDto {
  data: DeadlineEventDto[];
}

export interface DeadlineResponseDto {
  deadline: DeadlineInstanceDto;
}

export interface DeadlineSummaryItemDto {
  deadlineId: string;
  deadlineAt: string;
  status: DeadlineStatus;
  remainingMinutes: number | null;
  delayMinutes: number | null;
  severity: DeadlineEventSeverity;
}

export interface OrderStageDeadlineSummaryDto extends DeadlineSummaryItemDto {
  orderWorkshopId: number | null;
  stageName?: string | null;
}

export interface OrderDeadlineSummaryDto {
  orderId: number;
  finalDeadline: DeadlineSummaryItemDto | null;
  currentStageDeadline: OrderStageDeadlineSummaryDto | null;
  counts: {
    active: number;
    expired: number;
    completedLate: number;
    completedOnTime: number;
  };
}

export interface CreateDeadlineRequestDto {
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

export interface OverrideDeadlineRequestDto {
  deadlineAt: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface PauseDeadlineRequestDto {
  pauseMode: DeadlinePauseMode;
  pauseReason: string;
  notes?: string | null;
}

export interface ResumeDeadlineRequestDto {
  notes?: string | null;
}

export interface CancelDeadlineRequestDto {
  reason: string;
}
