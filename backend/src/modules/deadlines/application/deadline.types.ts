import type { CurrentUser } from '../../../permissions/current-user';
import type {
  DeadlineActionExecutionDto,
  DeadlineActionRuleDto,
  DeadlineOrderOverrideDto,
  OrderEffectiveDeadlineRulesDto,
  PreviewOrderDeadlineActionRulesDto,
  PreviewOrderDeadlineActionRulesRequestDto,
  DeadlineRuleConfigSnapshotDto,
  CreateGlobalTransitionRuleRequestDto,
  DeleteGlobalTransitionRuleRequestDto,
  UpdateGlobalTransitionRuleRequestDto,
  UpsertDeadlineOrderOverrideInput,
} from '../dto/deadline-action-rule.dto';
import type {
  DeadlineAuditContract,
  DeadlineOrderOverrideAuditContract,
} from '../domain/deadline-actions';
import type {
  CancelDeadlineRequestDto,
  CreateDeadlineRequestDto,
  DeadlineEventDto,
  DeadlineInstanceDto,
  OverrideDeadlineRequestDto,
  PauseDeadlineRequestDto,
  ResumeDeadlineRequestDto,
} from '../dto/deadline-instance.dto';
import type {
  CreateDeadlinePolicyRequestDto,
  DeadlinePolicyDto,
  UpdateDeadlinePolicyRequestDto,
} from '../dto/deadline-policy.dto';
import type {
  DeadlineSettingsDto,
  UpdateDeadlineSettingsRequestDto,
} from '../dto/deadline-settings.dto';
import type { DeadlineActionType } from '../domain/deadline-actions';
import type { DeadlineEventSeverity, DeadlineEventType } from '../domain/deadline-events';
import type { DeadlineStatus } from '../domain/deadline-status';
import type { DeadlineEntityType } from '../domain/deadline-validation';

export const DEADLINE_LIST_SORT_FIELDS = [
  'deadlineAt',
  'status',
  'entityType',
  'orderId',
  'responsibleUserId',
  'createdAt',
  'updatedAt',
] as const;

export type DeadlineListSortBy = (typeof DEADLINE_LIST_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';

export interface DeadlineListQuery {
  page: number;
  pageSize: number;
  sortBy: DeadlineListSortBy;
  sortOrder: SortOrder;
  entityType?: DeadlineEntityType;
  entityId?: string;
  orderId?: number;
  status?: DeadlineStatus;
  responsibleUserId?: number;
  dateFrom?: string;
  dateTo?: string;
  onlyOverdue: boolean;
}

export interface ListDeadlinesCommand {
  currentUser: CurrentUser;
  query: DeadlineListQuery;
}

export interface GetDeadlineByIdCommand {
  currentUser: CurrentUser;
  deadlineId: string;
}

export interface ListOrderDeadlinesCommand {
  currentUser: CurrentUser;
  orderId: number;
}

export interface ListOrderDeadlineEventsCommand extends ListOrderDeadlinesCommand {}

export interface CreateDeadlineCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dto: CreateDeadlineRequestDto;
}

export interface OverrideDeadlineCommand {
  currentUser: CurrentUser;
  deadlineId: string;
  requestId?: string;
  dto: OverrideDeadlineRequestDto;
}

export interface PauseDeadlineCommand {
  currentUser: CurrentUser;
  deadlineId: string;
  requestId?: string;
  dto: PauseDeadlineRequestDto;
}

export interface ResumeDeadlineCommand {
  currentUser: CurrentUser;
  deadlineId: string;
  requestId?: string;
  dto: ResumeDeadlineRequestDto;
}

export interface CancelDeadlineCommand {
  currentUser: CurrentUser;
  deadlineId: string;
  requestId?: string;
  dto: CancelDeadlineRequestDto;
}

export interface ListDeadlinePoliciesCommand {
  currentUser: CurrentUser;
}

export interface CreateDeadlinePolicyCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dto: CreateDeadlinePolicyRequestDto;
}

export interface UpdateDeadlinePolicyCommand {
  currentUser: CurrentUser;
  requestId?: string;
  policyId: string;
  dto: UpdateDeadlinePolicyRequestDto;
}

export interface GetDeadlineSettingsCommand {
  currentUser: CurrentUser;
}

export interface UpdateDeadlineSettingsCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dto: UpdateDeadlineSettingsRequestDto;
}

export interface UpsertDeadlineOrderOverrideCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dto: UpsertDeadlineOrderOverrideInput;
  audit: DeadlineOrderOverrideAuditContract;
}

export interface RetireDeadlineOrderOverrideCommand {
  currentUser: CurrentUser;
  requestId?: string;
  orderId: number;
  overrideId: string;
  reason: string;
  audit: DeadlineOrderOverrideAuditContract;
}

export interface ListOrderEffectiveDeadlineRulesCommand {
  currentUser: CurrentUser;
  orderId: number;
}

export interface PreviewOrderDeadlineActionRulesCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: PreviewOrderDeadlineActionRulesRequestDto;
}

export interface ListGlobalTransitionRulesCommand {
  currentUser: CurrentUser;
}

export interface CreateGlobalTransitionRuleCommand {
  currentUser: CurrentUser;
  requestId: string;
  dto: CreateGlobalTransitionRuleRequestDto;
  audit: DeadlineAuditContract;
}

export interface UpdateGlobalTransitionRuleCommand {
  currentUser: CurrentUser;
  requestId: string;
  actionRuleId: string;
  dto: UpdateGlobalTransitionRuleRequestDto;
  audit: DeadlineAuditContract;
}

export interface DeleteGlobalTransitionRuleCommand {
  currentUser: CurrentUser;
  requestId: string;
  actionRuleId: string;
  dto: DeleteGlobalTransitionRuleRequestDto;
  audit: DeadlineAuditContract;
}

export interface OrderDeadlineEvaluationContext {
  orderId: number;
  orderStatusId: number;
  isCompleted: boolean;
}

export interface DeadlineEventCurrentForOrderQuery {
  orderId: number;
  deadlineId?: string | null;
  deadlineEventId?: string | null;
}

export interface FindDueDeadlinesCommand {
  now: string;
  limit: number;
  workerId: string;
}

export interface DeadlineTargetRef {
  entityType: DeadlineEntityType;
  entityId: string;
  orderId?: number | null;
  orderWorkshopId?: number | null;
  clientId?: number | null;
}

export interface DeadlineTargetState {
  isCompleted: boolean;
  completedAt?: string | null;
  responsibleUserIds: number[];
  notificationRecipients?: {
    assigneeUserId?: number | null;
    managerUserId?: number | null;
    departmentHeadUserId?: number | null;
  };
  auditContext: Record<string, unknown>;
}

export interface CreateDeadlineEventInput {
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
  idempotencyKey?: string | null;
}

export interface CreateDeadlineEventResult {
  event: DeadlineEventDto;
  created: boolean;
}

export interface CreateActionExecutionInput {
  deadlineEventId: string;
  actionRuleId?: string | null;
  actionType: DeadlineActionType;
  targetType?: string | null;
  targetId?: string | null;
  status: 'executed' | 'skipped' | 'failed';
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
}

export interface DeadlineRepositoryPort {
  listDeadlines(command: ListDeadlinesCommand): Promise<{
    data: DeadlineInstanceDto[];
    total: number;
  }>;
  getDeadlineById(deadlineId: string): Promise<DeadlineInstanceDto | null>;
  getDeadlineByIdForUpdate(deadlineId: string): Promise<DeadlineInstanceDto | null>;
  listOrderDeadlines(orderId: number): Promise<DeadlineInstanceDto[]>;
  listOrderDeadlineEvents(orderId: number): Promise<DeadlineEventDto[]>;
  listPolicies(): Promise<DeadlinePolicyDto[]>;
  createPolicy(command: CreateDeadlinePolicyCommand): Promise<DeadlinePolicyDto>;
  updatePolicy(command: UpdateDeadlinePolicyCommand): Promise<DeadlinePolicyDto>;
  getSettings(): Promise<DeadlineSettingsDto>;
  updateSettings(command: UpdateDeadlineSettingsCommand): Promise<DeadlineSettingsDto>;
  createDeadlineInstance(command: CreateDeadlineCommand): Promise<DeadlineInstanceDto>;
  overrideDeadline(command: OverrideDeadlineCommand): Promise<DeadlineInstanceDto>;
  pauseDeadline(command: PauseDeadlineCommand): Promise<DeadlineInstanceDto>;
  resumeDeadline(command: ResumeDeadlineCommand): Promise<DeadlineInstanceDto>;
  cancelDeadline(command: CancelDeadlineCommand): Promise<DeadlineInstanceDto>;
  findDueDeadlinesForUpdate(command: FindDueDeadlinesCommand): Promise<DeadlineInstanceDto[]>;
  markDeadlineExpired(input: {
    deadlineId: string;
    expiredAt: string;
  }): Promise<DeadlineInstanceDto>;
  markDeadlineCompleted(input: {
    deadlineId: string;
    status: Extract<DeadlineStatus, 'completed_on_time' | 'completed_late'>;
    completedAt: string;
  }): Promise<DeadlineInstanceDto>;
  createDeadlineEvent(input: CreateDeadlineEventInput): Promise<CreateDeadlineEventResult>;
  listActionRules(input: {
    scopeType: DeadlineEntityType;
    eventType: DeadlineEventType;
  }): Promise<DeadlineActionRuleDto[]>;
  createActionExecution(input: CreateActionExecutionInput): Promise<DeadlineActionExecutionDto>;
  listOrderOverrides(orderId: number): Promise<DeadlineOrderOverrideDto[]>;
  listOrderActionRuleOverrides(orderId: number, actionRuleIds: string[]): Promise<DeadlineOrderOverrideDto[]>;
  upsertOrderOverride(command: UpsertDeadlineOrderOverrideCommand): Promise<DeadlineOrderOverrideDto>;
  retireOrderOverride(command: RetireDeadlineOrderOverrideCommand): Promise<DeadlineOrderOverrideDto>;
  listGlobalTransitionRules(): Promise<DeadlineActionRuleDto[]>;
  createGlobalTransitionRule(command: CreateGlobalTransitionRuleCommand): Promise<DeadlineActionRuleDto>;
  updateGlobalTransitionRule(command: UpdateGlobalTransitionRuleCommand): Promise<DeadlineActionRuleDto>;
  deleteGlobalTransitionRule(command: DeleteGlobalTransitionRuleCommand): Promise<DeadlineActionRuleDto>;
  getOrderDeadlineEvaluationContext(orderId: number): Promise<OrderDeadlineEvaluationContext | null>;
  isDeadlineEventCurrentForOrder(query: DeadlineEventCurrentForOrderQuery): Promise<boolean>;
}

export interface DeadlineUnitOfWork {
  deadlines: DeadlineRepositoryPort;
  statusActionPort?: DeadlineOrderStatusActionPort;
  productionStatusActionPort?: DeadlineProductionStatusActionPort;
  projectDeadlineOverduePort?: DeadlineProjectDeadlineOverdueNotificationPort;
}

export interface DeadlineTransactionManagerPort {
  runInTransaction<T>(handler: (unitOfWork: DeadlineUnitOfWork) => Promise<T>): Promise<T>;
}

export interface DeadlineTargetResolverPort {
  resolveTargetState(input: DeadlineTargetRef): Promise<DeadlineTargetState>;
  canApplyAction(input: {
    actionType: DeadlineActionType;
    target: DeadlineTargetRef;
  }): Promise<boolean>;
}

export interface DeadlineNotificationInput {
  userId: number;
  level: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  sourceType: 'deadline';
  sourceId: string;
  idempotencyKey: string;
}

export interface DeadlineNotificationResult {
  created: boolean;
  notificationId: string | null;
}

export interface DeadlineNotificationPort {
  createNotification(input: DeadlineNotificationInput): Promise<DeadlineNotificationResult>;
}

export type DeadlineProjectDeadlineOverdueSkipReason =
  | 'project_p8_notifications_disabled'
  | 'no_order_visibility_anchor'
  | 'no_project_link'
  | 'owned_by_notification_engine';

export interface DeadlineProjectDeadlineOverdueNotificationInput {
  deadlineEventId: string;
  deadlineInstanceId: string;
  orderId: string | null;
  actorUserId: string | null;
  requestId: string;
}

export interface DeadlineProjectDeadlineOverdueNotificationPort {
  notifyDeadlineOverdue(input: DeadlineProjectDeadlineOverdueNotificationInput): Promise<void>;
  /**
   * Records a structured skip event (mirrors the existing
   * `pg-project-deadline-overdue-notification-port.recordSkipped` private
   * helper) so the inline path leaves a query/report-ready trail when it
   * does NOT call the P8 service. Used by the convergence cutover to
   * explain why no project_notification was written for a
   * `DEADLINE_EXPIRED` envelope: the notification engine now owns the
   * event and the engine's `project_participants` resolver handles
   * delivery.
   */
  recordSkipped(
    input: DeadlineProjectDeadlineOverdueNotificationInput,
    skipReason: DeadlineProjectDeadlineOverdueSkipReason,
  ): Promise<void>;
}

export interface DeadlineChangeOrderStatusCommand {
  source: 'deadline-engine';
  systemActor: {
    type: 'system';
    actorUserId: null;
    actorLabel: 'deadline-engine';
  };
  orderId: number;
  targetOrderStatusId: number;
  deadlineId: string;
  deadlineEventId: string;
  actionRuleId: string;
  ruleVersionId?: string | null;
  ruleConfigSnapshot: DeadlineRuleConfigSnapshotDto;
  idempotencyKey: string;
  requestId?: string;
  occurredAt: string;
}

export interface DeadlineChangeOrderStatusResult {
  status: 'executed' | 'skipped';
  skipReason?: string | null;
  result?: Record<string, unknown> | null;
}

export interface DeadlineOrderStatusActionPort {
  changeOrderStatusFromDeadline(
    command: DeadlineChangeOrderStatusCommand,
  ): Promise<DeadlineChangeOrderStatusResult>;
}

export type DeadlineProductionStatusScope = 'order';

export interface DeadlineChangeProductionStatusCommand {
  source: 'deadline-engine';
  systemActor: {
    type: 'system';
    actorUserId: null;
    actorLabel: 'deadline-engine';
  };
  orderId: number;
  targetProductionStatusId: number;
  productionStatusScope: DeadlineProductionStatusScope;
  deadlineId: string;
  deadlineEventId: string;
  actionRuleId: string;
  ruleVersionId?: string | null;
  ruleConfigSnapshot: DeadlineRuleConfigSnapshotDto;
  idempotencyKey: string;
  requestId?: string;
  occurredAt: string;
}

export interface DeadlineChangeProductionStatusResult {
  status: 'executed' | 'skipped';
  skipReason?: string | null;
  result?: Record<string, unknown> | null;
}

export interface DeadlineProductionStatusActionPort {
  changeProductionStatusFromDeadline(
    command: DeadlineChangeProductionStatusCommand,
  ): Promise<DeadlineChangeProductionStatusResult>;
}
