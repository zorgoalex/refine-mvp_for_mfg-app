import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ProjectNotificationService } from '../../projects/notifications/project-notification.service';
import type {
  GetOrderProjectsCommand,
  OrderProjectLinkRepositoryPort,
  ReplaceOrderProjectsCommand,
} from './order-project-link.types';

export interface OrderProjectLinkServicePorts {
  links: OrderProjectLinkRepositoryPort;
  permissions?: PermissionsService;
  projectNotifications?: ProjectNotificationService;
  projectP8NotificationsEnabled?: boolean;
}

export class OrderProjectLinkService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: OrderProjectLinkServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  get(command: GetOrderProjectsCommand) {
    this.requireAny(command.currentUser, ['orders.view', 'projects.view']);
    return this.ports.links.getOrderProjects(command);
  }

  async replace(command: ReplaceOrderProjectsCommand) {
    this.requirePermission(command.currentUser, 'projects.manage_links');
    const before = this.ports.projectP8NotificationsEnabled
      ? await this.ports.links.getOrderProjects(command)
      : null;
    const response = await this.ports.links.replaceOrderProjects(command);

    const p8NotificationFacts = internalOrderP8Facts(response);
    if (this.ports.projectP8NotificationsEnabled && response.changed) {
      await this.notifyOrderProjectChanges(command, p8NotificationFacts, before?.projects, response.projects);
    }

    return publicOrderProjectResponse(response);
  }

  private async notifyOrderProjectChanges(
    command: ReplaceOrderProjectsCommand,
    persistedFacts: Array<{ orderId: string; projectId: string; action: 'added' | 'removed' }>,
    before: Array<{ id: string }> | undefined,
    after: Array<{ id: string }>,
  ): Promise<void> {
    if (!this.ports.projectNotifications) return;

    const facts = persistedFacts.length > 0 || !before
      ? persistedFacts
      : orderProjectFactsFromDiff(command.orderId, before, after);

    if (facts.length === 0) return;

    await this.ports.projectNotifications.handleProjectOrderLinksChanged({
      sourceId: command.dto.idempotencyKey,
      actorUserId: command.currentUser.id,
      requestId: command.requestId ?? command.dto.idempotencyKey,
      facts,
    });
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }

  private requireAny(currentUser: CurrentUser, permissions: PermissionName[]): void {
    if (!this.permissions.canUserAny(currentUser, permissions)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: permissions,
      });
    }
  }
}

function orderProjectFactsFromDiff(
  orderId: number,
  before: Array<{ id: string }>,
  after: Array<{ id: string }>,
): Array<{ orderId: string; projectId: string; action: 'added' | 'removed' }> {
  const beforeIds = new Set(before.map((project) => project.id));
  const afterIds = new Set(after.map((project) => project.id));
  return [
    ...after.filter((project) => !beforeIds.has(project.id)).map((project) => ({
      orderId: String(orderId),
      projectId: project.id,
      action: 'added' as const,
    })),
    ...before.filter((project) => !afterIds.has(project.id)).map((project) => ({
      orderId: String(orderId),
      projectId: project.id,
      action: 'removed' as const,
    })),
  ];
}

function internalOrderP8Facts(response: unknown): Array<{ orderId: string; projectId: string; action: 'added' | 'removed' }> {
  const facts = (response as { p8NotificationFacts?: unknown }).p8NotificationFacts;
  if (!Array.isArray(facts)) return [];
  return facts.filter(isOrderP8Fact);
}

function isOrderP8Fact(value: unknown): value is { orderId: string; projectId: string; action: 'added' | 'removed' } {
  if (!value || typeof value !== 'object') return false;
  const fact = value as Record<string, unknown>;
  return typeof fact.orderId === 'string'
    && typeof fact.projectId === 'string'
    && (fact.action === 'added' || fact.action === 'removed');
}

function publicOrderProjectResponse<T extends object>(response: T): T {
  const { p8NotificationFacts: _p8NotificationFacts, ...publicResponse } = response as T & { p8NotificationFacts?: unknown };
  return publicResponse as T;
}
