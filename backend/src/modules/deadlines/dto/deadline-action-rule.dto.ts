import type {
  DeadlineActionExecutionStatus,
  DeadlineActionType,
  DeadlineOrderOverrideTargetType,
} from '../domain/deadline-actions';
import type { DeadlineEventType } from '../domain/deadline-events';
import type { DeadlinePolicyDto } from './deadline-policy.dto';
import type { DeadlineEntityType } from '../domain/deadline-validation';

export interface DeadlineActionRuleConditionsDto {
  allowedFromOrderStatusIds?: number[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
  requireCurrentDeadlineEvent?: boolean;
}

export interface DeadlineActionRuleActionConfigDto {
  targetOrderStatusId?: number;
  targetProductionStatusId?: number;
  productionStatusScope?: 'order';
}

export interface DeadlineActionRuleConfigDto {
  scope?: {
    type: 'global_orders';
  };
  conditions?: DeadlineActionRuleConditionsDto;
  actionConfig?: DeadlineActionRuleActionConfigDto;
  ruleCode?: string;
  fixtureKey?: string;
}

export interface DeadlineRuleConfigSnapshotDto {
  actionRuleId: string;
  priority: number;
  eventType: DeadlineEventType;
  actionType: DeadlineActionType;
  conditions: DeadlineActionRuleConditionsDto;
  actionConfig: DeadlineActionRuleActionConfigDto;
  createdAt: string;
  updatedAt: string;
  snapshotHash: string;
}

export interface DeadlineActionRuleDto {
  actionRuleId: string;
  policyId?: string | null;
  scopeType: DeadlineEntityType;
  eventType: DeadlineEventType;
  actionType: DeadlineActionType;
  isEnabled: boolean;
  priority: number;
  config?: DeadlineActionRuleConfigDto | null;
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
  ruleConfigSnapshot?: DeadlineRuleConfigSnapshotDto;
  ruleVersionId?: string | null;
  orderId?: number | null;
  targetStatusId?: number | null;
  executedAt?: string | null;
  createdAt: string;
}

export interface DeadlineOrderOverrideDto {
  overrideId: string;
  orderId: number;
  targetType: DeadlineOrderOverrideTargetType;
  policyId?: string | null;
  actionRuleId?: string | null;
  isDisabled: boolean;
  overrideConfig: DeadlineOrderOverrideConfigDto;
  reason: string;
  createdByUserId: number;
  updatedByUserId: number;
  retiredByUserId?: number | null;
  retiredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveDeadlinePolicyRuleDto extends DeadlinePolicyDto {
  override: DeadlineOrderOverrideDto | null;
}

export interface EffectiveDeadlineActionRuleDto extends DeadlineActionRuleDto {
  override: DeadlineOrderOverrideDto | null;
}

export interface OrderEffectiveDeadlineRulesDto {
  orderId: number;
  policies: EffectiveDeadlinePolicyRuleDto[];
  actionRules: EffectiveDeadlineActionRuleDto[];
  overrides: DeadlineOrderOverrideDto[];
}

export interface PreviewDeadlineActionRuleCandidateDto {
  actionRuleId: string;
  priority: number;
  actionType: DeadlineActionType;
  wouldRun: boolean;
  wouldSkipReason: string | null;
  targetOrderStatusId: number | null;
  overrideId: string | null;
}

export interface PreviewOrderDeadlineActionRulesRequestDto {
  eventType: 'DEADLINE_EXPIRED';
  deadlineId?: string | null;
  deadlineEventId?: string | null;
  fixtureKey?: string | null;
}

export interface PreviewOrderDeadlineActionRulesDto {
  orderId: number;
  eventType: 'DEADLINE_EXPIRED';
  deadlineId?: string | null;
  deadlineEventId?: string | null;
  candidateActionRules: PreviewDeadlineActionRuleCandidateDto[];
  selectedActionRuleId: string | null;
  selectionReason: string;
}

export interface CreateGlobalTransitionRuleRequestDto {
  ruleCode?: string;
  isEnabled?: false;
  priority?: number;
  eventType?: 'DEADLINE_EXPIRED';
  actionType?: 'change_order_status';
  targetOrderStatusId: number;
  allowedFromOrderStatusIds: number[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
  requireCurrentDeadlineEvent?: boolean;
  reason: string;
  comment?: string | null;
}

export interface UpdateGlobalTransitionRuleRequestDto {
  expectedUpdatedAt: string;
  enabled?: boolean;
  isEnabled?: boolean;
  priority?: number;
  eventType?: 'DEADLINE_EXPIRED';
  actionType?: 'change_order_status';
  targetOrderStatusId?: number;
  allowedFromOrderStatusIds?: number[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
  requireCurrentDeadlineEvent?: boolean;
  reason: string;
  comment?: string | null;
}

export interface DeleteGlobalTransitionRuleRequestDto {
  expectedUpdatedAt: string;
  reason: string;
  comment?: string | null;
}

interface BaseUpsertDeadlineOrderOverrideInput {
  orderId: number;
  isDisabled?: boolean;
  overrideConfig?: DeadlineOrderOverrideConfigDto;
  reason: string;
}

export interface UpsertDeadlinePolicyOverrideInput extends BaseUpsertDeadlineOrderOverrideInput {
  targetType: 'policy';
  policyId: string;
  actionRuleId?: never;
}

export interface UpsertDeadlineActionRuleOverrideInput extends BaseUpsertDeadlineOrderOverrideInput {
  targetType: 'action_rule';
  actionRuleId: string;
  policyId?: never;
}

export type UpsertDeadlineOrderOverrideInput =
  | UpsertDeadlinePolicyOverrideInput
  | UpsertDeadlineActionRuleOverrideInput;

export function getDeadlineOrderOverrideTarget(input: UpsertDeadlineOrderOverrideInput): {
  targetType: DeadlineOrderOverrideTargetType;
  targetId: string;
} {
  return input.targetType === 'policy'
    ? { targetType: input.targetType, targetId: input.policyId }
    : { targetType: input.targetType, targetId: input.actionRuleId };
}

export interface DeadlineOrderOverrideConfigDto {
  conditions?: Partial<DeadlineActionRuleConditionsDto>;
  actionConfig?: Partial<DeadlineActionRuleActionConfigDto>;
  timerConfig?: {
    durationValue?: number;
    durationUnit?: 'minute' | 'hour' | 'day' | 'working_hour' | 'working_day';
  };
}
