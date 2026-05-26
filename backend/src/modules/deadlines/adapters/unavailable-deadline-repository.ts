import type {
  DeadlineActionExecutionDto,
  DeadlineActionRuleDto,
  DeadlineOrderOverrideDto,
} from '../dto/deadline-action-rule.dto';
import type { DeadlineEventDto, DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import type { DeadlinePolicyDto } from '../dto/deadline-policy.dto';
import type { DeadlineSettingsDto } from '../dto/deadline-settings.dto';
import { DEFAULT_DEADLINE_SETTINGS } from '../dto/deadline-settings.dto';
import { deadlineAdapterUnavailableError } from '../errors/deadline.errors';
import type {
  CreateActionExecutionInput,
  CreateDeadlineCommand,
  CreateDeadlineEventInput,
  CreateDeadlineEventResult,
  CreateDeadlinePolicyCommand,
  DeadlineRepositoryPort,
  FindDueDeadlinesCommand,
  ListDeadlinesCommand,
  OrderDeadlineEvaluationContext,
  RetireDeadlineOrderOverrideCommand,
  UpdateDeadlinePolicyCommand,
  UpdateGlobalTransitionRuleCommand,
  UpdateDeadlineSettingsCommand,
  UpsertDeadlineOrderOverrideCommand,
} from '../application/deadline.types';

export class UnavailableDeadlineRepository implements DeadlineRepositoryPort {
  async listDeadlines(_command: ListDeadlinesCommand): Promise<{
    data: DeadlineInstanceDto[];
    total: number;
  }> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async getDeadlineById(_deadlineId: string): Promise<DeadlineInstanceDto | null> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async getDeadlineByIdForUpdate(_deadlineId: string): Promise<DeadlineInstanceDto | null> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listOrderDeadlines(_orderId: number): Promise<DeadlineInstanceDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listOrderDeadlineEvents(_orderId: number): Promise<DeadlineEventDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listPolicies(): Promise<DeadlinePolicyDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async createPolicy(_command: CreateDeadlinePolicyCommand): Promise<DeadlinePolicyDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async updatePolicy(_command: UpdateDeadlinePolicyCommand): Promise<DeadlinePolicyDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async getSettings(): Promise<DeadlineSettingsDto> {
    return DEFAULT_DEADLINE_SETTINGS;
  }

  async updateSettings(_command: UpdateDeadlineSettingsCommand): Promise<DeadlineSettingsDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async createDeadlineInstance(_command: CreateDeadlineCommand): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async overrideDeadline(): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async pauseDeadline(): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async resumeDeadline(): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async cancelDeadline(): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async findDueDeadlinesForUpdate(
    _command: FindDueDeadlinesCommand,
  ): Promise<DeadlineInstanceDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async markDeadlineExpired(): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async markDeadlineCompleted(): Promise<DeadlineInstanceDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async createDeadlineEvent(_input: CreateDeadlineEventInput): Promise<CreateDeadlineEventResult> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listActionRules(): Promise<[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async createActionExecution(
    _input: CreateActionExecutionInput,
  ): Promise<DeadlineActionExecutionDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listOrderOverrides(_orderId: number): Promise<DeadlineOrderOverrideDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listOrderActionRuleOverrides(
    _orderId: number,
    _actionRuleIds: string[],
  ): Promise<DeadlineOrderOverrideDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async upsertOrderOverride(
    _command: UpsertDeadlineOrderOverrideCommand,
  ): Promise<DeadlineOrderOverrideDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async retireOrderOverride(
    _command: RetireDeadlineOrderOverrideCommand,
  ): Promise<DeadlineOrderOverrideDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async listGlobalTransitionRules(): Promise<DeadlineActionRuleDto[]> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async updateGlobalTransitionRule(
    _command: UpdateGlobalTransitionRuleCommand,
  ): Promise<DeadlineActionRuleDto> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }

  async getOrderDeadlineEvaluationContext(
    orderId: number,
  ): Promise<OrderDeadlineEvaluationContext | null> {
    throw deadlineAdapterUnavailableError(`deadline_repository:${orderId}`);
  }

  async isDeadlineEventCurrentForOrder(): Promise<boolean> {
    throw deadlineAdapterUnavailableError('deadline_repository');
  }
}
