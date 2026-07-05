import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { GroupNotificationService } from '../../groups/notifications/group-notification.service';
import type {
  GetOrderGroupsCommand,
  OrderGroupLinkRepositoryPort,
  ReplaceOrderGroupsCommand,
} from './order-group-link.types';

export interface OrderGroupLinkServicePorts {
  links: OrderGroupLinkRepositoryPort;
  permissions?: PermissionsService;
  groupNotifications?: GroupNotificationService;
  groupP8NotificationsEnabled?: boolean;
}

export class OrderGroupLinkService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: OrderGroupLinkServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  get(command: GetOrderGroupsCommand) {
    this.requireAny(command.currentUser, ['orders.view', 'groups.view']);
    return this.ports.links.getOrderGroups(command);
  }

  async replace(command: ReplaceOrderGroupsCommand) {
    this.requirePermission(command.currentUser, 'groups.manage_links');
    const before = this.ports.groupP8NotificationsEnabled
      ? await this.ports.links.getOrderGroups(command)
      : null;
    const response = await this.ports.links.replaceOrderGroups(command);

    const p8NotificationFacts = internalOrderP8Facts(response);
    if (this.ports.groupP8NotificationsEnabled && response.changed) {
      await this.notifyOrderGroupChanges(command, p8NotificationFacts, before?.groups, response.groups);
    }

    return publicOrderGroupResponse(response);
  }

  private async notifyOrderGroupChanges(
    command: ReplaceOrderGroupsCommand,
    persistedFacts: Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }>,
    before: Array<{ id: string }> | undefined,
    after: Array<{ id: string }>,
  ): Promise<void> {
    if (!this.ports.groupNotifications) return;

    const facts = persistedFacts.length > 0 || !before
      ? persistedFacts
      : orderGroupFactsFromDiff(command.orderId, before, after);

    if (facts.length === 0) return;

    await this.ports.groupNotifications.handleGroupOrderLinksChanged({
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

function orderGroupFactsFromDiff(
  orderId: number,
  before: Array<{ id: string }>,
  after: Array<{ id: string }>,
): Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }> {
  const beforeIds = new Set(before.map((group) => group.id));
  const afterIds = new Set(after.map((group) => group.id));
  return [
    ...after.filter((group) => !beforeIds.has(group.id)).map((group) => ({
      orderId: String(orderId),
      groupId: group.id,
      action: 'added' as const,
    })),
    ...before.filter((group) => !afterIds.has(group.id)).map((group) => ({
      orderId: String(orderId),
      groupId: group.id,
      action: 'removed' as const,
    })),
  ];
}

function internalOrderP8Facts(response: unknown): Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }> {
  const facts = (response as { p8NotificationFacts?: unknown }).p8NotificationFacts;
  if (!Array.isArray(facts)) return [];
  return facts.filter(isOrderP8Fact);
}

function isOrderP8Fact(value: unknown): value is { orderId: string; groupId: string; action: 'added' | 'removed' } {
  if (!value || typeof value !== 'object') return false;
  const fact = value as Record<string, unknown>;
  return typeof fact.orderId === 'string'
    && typeof fact.groupId === 'string'
    && (fact.action === 'added' || fact.action === 'removed');
}

function publicOrderGroupResponse<T extends object>(response: T): T {
  const { p8NotificationFacts: _p8NotificationFacts, ...publicResponse } = response as T & { p8NotificationFacts?: unknown };
  return publicResponse as T;
}
