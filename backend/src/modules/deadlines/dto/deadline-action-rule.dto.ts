import type { DeadlineActionExecutionStatus, DeadlineActionType } from '../domain/deadline-actions';
import type { DeadlineEventType } from '../domain/deadline-events';
import type { DeadlineEntityType } from '../domain/deadline-validation';

export interface DeadlineActionRuleDto {
  actionRuleId: string;
  policyId?: string | null;
  scopeType: DeadlineEntityType;
  eventType: DeadlineEventType;
  actionType: DeadlineActionType;
  isEnabled: boolean;
  config?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeadlineActionExecutionDto {
  actionExecutionId: string;
  deadlineEventId: string;
  actionRuleId?: string | null;
  actionType: DeadlineActionType;
  targetType?: string | null;
  targetId?: string | null;
  status: DeadlineActionExecutionStatus;
  idempotencyKey: string;
  skipReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  result?: Record<string, unknown> | null;
  executedAt?: string | null;
  createdAt: string;
}
