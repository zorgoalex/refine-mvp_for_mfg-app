import type { CurrentUser } from '../../../permissions/current-user';
import type { DeadlineActionExecutionDto, DeadlineActionRuleDto } from '../dto/deadline-action-rule.dto';
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
  dto: CreateDeadlinePolicyRequestDto;
}

export interface UpdateDeadlinePolicyCommand {
  currentUser: CurrentUser;
  policyId: string;
  dto: UpdateDeadlinePolicyRequestDto;
}

export interface GetDeadlineSettingsCommand {
  currentUser: CurrentUser;
}

export interface UpdateDeadlineSettingsCommand {
  currentUser: CurrentUser;
  dto: UpdateDeadlineSettingsRequestDto;
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
}

export interface DeadlineUnitOfWork {
  deadlines: DeadlineRepositoryPort;
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

export interface DeadlineNotificationPort {
  createNotification(input: {
    userId: number;
    level: 'info' | 'warning' | 'error';
    title: string;
    message: string;
    entityType?: string | null;
    entityId?: string | null;
    sourceType: 'deadline';
    sourceId: string;
  }): Promise<void>;
}
