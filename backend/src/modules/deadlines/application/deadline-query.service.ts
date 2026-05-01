import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { PermissionName } from '../../../permissions/permissions';
import { calculateDeadlineTiming } from '../domain/deadline-calculator';
import type { DeadlineInstanceDto, OrderDeadlineSummaryDto } from '../dto/deadline-instance.dto';
import { DeadlineNotFoundError } from '../errors/deadline.errors';
import type {
  DeadlineRepositoryPort,
  GetDeadlineByIdCommand,
  GetDeadlineSettingsCommand,
  ListDeadlinePoliciesCommand,
  ListDeadlinesCommand,
  ListOrderDeadlineEventsCommand,
  ListOrderDeadlinesCommand,
} from './deadline.types';

export interface DeadlineQueryServicePorts {
  repository: DeadlineRepositoryPort;
  permissions?: PermissionsService;
}

export class DeadlineQueryService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: DeadlineQueryServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListDeadlinesCommand) {
    this.requirePermission(command, 'deadlines.view');
    const result = await this.ports.repository.listDeadlines(command);

    return {
      data: result.data,
      pagination: {
        page: command.query.page,
        pageSize: command.query.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / command.query.pageSize),
      },
    };
  }

  async getById(command: GetDeadlineByIdCommand): Promise<DeadlineInstanceDto> {
    this.requirePermission(command, 'deadlines.view');

    const deadline = await this.ports.repository.getDeadlineById(command.deadlineId);
    if (!deadline) {
      throw new DeadlineNotFoundError(command.deadlineId);
    }

    return deadline;
  }

  async listOrderDeadlines(command: ListOrderDeadlinesCommand) {
    this.requirePermission(command, 'deadlines.view');
    return { data: await this.ports.repository.listOrderDeadlines(command.orderId) };
  }

  async listOrderDeadlineEvents(command: ListOrderDeadlineEventsCommand) {
    this.requirePermission(command, 'deadlines.audit.view');
    return { data: await this.ports.repository.listOrderDeadlineEvents(command.orderId) };
  }

  async getOrderDeadlineSummary(
    command: ListOrderDeadlinesCommand,
    now: string = new Date().toISOString(),
  ): Promise<OrderDeadlineSummaryDto> {
    this.requirePermission(command, 'deadlines.view');
    const deadlines = await this.ports.repository.listOrderDeadlines(command.orderId);

    return buildOrderDeadlineSummary(command.orderId, deadlines, now);
  }

  async listPolicies(command: ListDeadlinePoliciesCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');
    return { data: await this.ports.repository.listPolicies() };
  }

  async getSettings(command: GetDeadlineSettingsCommand) {
    this.requirePermission(command, 'deadlines.actions.manage');
    return { settings: await this.ports.repository.getSettings() };
  }

  private requirePermission(
    command: { currentUser: Parameters<PermissionsService['canUser']>[0] },
    permission: PermissionName,
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}

export function buildOrderDeadlineSummary(
  orderId: number,
  deadlines: DeadlineInstanceDto[],
  now: string,
): OrderDeadlineSummaryDto {
  const orderDeadlines = deadlines.filter((deadline) => deadline.orderId === orderId);
  const finalDeadline = orderDeadlines
    .filter((deadline) => deadline.entityType === 'order')
    .sort(byDeadlineAtAsc)[0];
  const currentStageDeadline = orderDeadlines
    .filter((deadline) => deadline.entityType === 'order_stage')
    .sort(byCurrentStagePriority)[0];

  return {
    orderId,
    finalDeadline: finalDeadline ? toSummaryItem(finalDeadline, now) : null,
    currentStageDeadline: currentStageDeadline
      ? {
          ...toSummaryItem(currentStageDeadline, now),
          orderWorkshopId: currentStageDeadline.orderWorkshopId ?? null,
          stageName:
            typeof currentStageDeadline.metadata?.stageName === 'string'
              ? currentStageDeadline.metadata.stageName
              : null,
        }
      : null,
    counts: {
      active: orderDeadlines.filter((deadline) => deadline.status === 'active').length,
      expired: orderDeadlines.filter((deadline) => deadline.status === 'expired').length,
      completedLate: orderDeadlines.filter((deadline) => deadline.status === 'completed_late')
        .length,
      completedOnTime: orderDeadlines.filter(
        (deadline) => deadline.status === 'completed_on_time',
      ).length,
    },
  };
}

function toSummaryItem(deadline: DeadlineInstanceDto, now: string) {
  const timing = calculateDeadlineTiming({
    deadlineAt: deadline.deadlineAt,
    status: deadline.status,
    now,
  });

  return {
    deadlineId: deadline.deadlineId,
    deadlineAt: deadline.deadlineAt,
    status: deadline.status,
    remainingMinutes: timing.remainingMinutes,
    delayMinutes: timing.delayMinutes,
    severity: timing.severity,
  };
}

function byDeadlineAtAsc(left: DeadlineInstanceDto, right: DeadlineInstanceDto): number {
  return Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt);
}

function byCurrentStagePriority(left: DeadlineInstanceDto, right: DeadlineInstanceDto): number {
  return statusPriority(left) - statusPriority(right) || byDeadlineAtAsc(left, right);
}

function statusPriority(deadline: DeadlineInstanceDto): number {
  if (deadline.status === 'expired') return 0;
  if (deadline.status === 'active') return 1;
  if (deadline.status === 'paused') return 2;

  return 3;
}
