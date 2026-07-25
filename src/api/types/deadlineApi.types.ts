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
export type DeadlineEventType = 'DEADLINE_EXPIRED' | string;
export type DeadlineActionType =
  | 'notify_assignee'
  | 'notify_manager'
  | 'notify_department_head'
  | 'set_overdue_flag'
  | 'change_order_status'
  | 'change_production_status'
  | 'escalate'
  | string;
export type DeadlineOrderOverrideTargetType = 'policy' | 'action_rule';

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
  targetType?: string | null;
  targetCode?: string | null;
  durationValue?: number | null;
  durationUnit?: 'minute' | 'hour' | 'day' | 'working_hour' | 'working_day' | null;
  startPoint?: string | null;
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

export interface DeadlineDefaultScheduleStageDto {
  productionStatusId: number;
  productionStatusName: string;
  productionStatusCode: string | null;
  sortOrder: number;
  durationDays: number | null;
  parallelWithPrevious: boolean;
  cumulativeDeadlineDays: number | null;
}

export interface DeadlineDefaultScheduleDto {
  configured: boolean;
  hasStoredConfiguration: boolean;
  version: number;
  reserveDays: number;
  totalProductionDays: number | null;
  plannedOrderDays: number | null;
  updatedAt: string | null;
  stages: DeadlineDefaultScheduleStageDto[];
}

export interface DeadlineDefaultScheduleResponse {
  schedule: DeadlineDefaultScheduleDto;
}

export interface ReplaceDeadlineDefaultScheduleRequest {
  expectedVersion: number;
  reserveDays: number;
  reason: string;
  stages: Array<{
    productionStatusId: number;
    durationDays: number;
    parallelWithPrevious: boolean;
  }>;
}

export interface DeadlineActionRuleConditionsDto {
  allowedFromOrderStatusIds?: number[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
  requireCurrentDeadlineEvent?: boolean;
}

export interface DeadlineActionRuleActionConfigDto {
  targetOrderStatusId?: number;
}

export interface DeadlineActionRuleConfigDto {
  scope?: {
    type: 'global_orders';
  };
  conditions?: DeadlineActionRuleConditionsDto;
  actionConfig?: DeadlineActionRuleActionConfigDto;
  ruleName?: string;
  ruleCode?: string;
  fixtureKey?: string;
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

export interface DeadlineOrderOverrideConfigDto {
  conditions?: Partial<DeadlineActionRuleConditionsDto>;
  actionConfig?: Partial<DeadlineActionRuleActionConfigDto>;
  timerConfig?: {
    durationValue?: number;
    durationUnit?: 'minute' | 'hour' | 'day' | 'working_hour' | 'working_day';
  };
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

export interface OrderEffectiveDeadlineRulesResponse {
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

export interface PreviewOrderDeadlineActionRulesRequest {
  eventType?: 'DEADLINE_EXPIRED';
  deadlineId?: string | null;
  deadlineEventId?: string | null;
  fixtureKey?: string | null;
}

export interface PreviewOrderDeadlineActionRulesResponse {
  orderId: number;
  eventType: 'DEADLINE_EXPIRED';
  deadlineId?: string | null;
  deadlineEventId?: string | null;
  candidateActionRules: PreviewDeadlineActionRuleCandidateDto[];
  selectedActionRuleId: string | null;
  selectionReason: string;
}

export type UpsertDeadlineOrderOverrideRequest =
  | {
      targetType: 'policy';
      policyId: string;
      actionRuleId?: never;
      isDisabled?: boolean;
      overrideConfig?: DeadlineOrderOverrideConfigDto;
      reason: string;
    }
  | {
      targetType: 'action_rule';
      actionRuleId: string;
      policyId?: never;
      isDisabled?: boolean;
      overrideConfig?: DeadlineOrderOverrideConfigDto;
      reason: string;
    };

export interface RetireDeadlineOrderOverrideRequest {
  reason: string;
}

export interface DeadlineOrderOverrideResponse {
  override: DeadlineOrderOverrideDto;
}

export interface DeadlineActionRuleListResponse {
  data: DeadlineActionRuleDto[];
  readiness: DeadlineTransitionRulesReadinessDto;
}

export interface DeadlineActionRuleResponse {
  rule: DeadlineActionRuleDto;
}

export interface DeadlineTransitionRulesReadinessDto {
  deadlinesEnabled: boolean;
  deadlinesReadOnly: boolean;
  workerEnabled: boolean;
  actionsEnabled: boolean;
  schedulerOwner: 'none' | 'in_process' | 'external';
  manualMutationReady: boolean;
  inProcessAutomaticReady: boolean;
  externalSchedulerOwnerSelected: boolean;
  automaticExecutionConfigured: boolean;
}

export interface CreateGlobalTransitionRuleRequest {
  ruleName: string;
  ruleCode?: string;
  policyId?: string | null;
  isEnabled?: boolean;
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

export interface UpdateGlobalTransitionRuleRequest {
  expectedUpdatedAt: string;
  ruleName?: string;
  ruleCode?: string | null;
  policyId?: string | null;
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

export interface DeleteGlobalTransitionRuleRequest {
  expectedUpdatedAt: string;
  reason: string;
  comment?: string | null;
}
