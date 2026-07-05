import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { OrderGroupLinkService } from './order-group-link.service';
import type { OrderGroupLinkRepositoryPort } from './order-group-link.types';

describe('OrderGroupLinkService', () => {
  it('notifies P8 order-link facts after a changed replace when gate is enabled', async () => {
    const links = fakeLinks();
    const notifications = fakeNotifications();
    const service = new OrderGroupLinkService({
      links,
      groupNotifications: notifications,
      groupP8NotificationsEnabled: true,
    });

    await service.replace({
      currentUser: user(['groups.manage_links']),
      orderId: 15,
      dto: {
        idempotencyKey: 'order-group-command-1',
        version: 1,
        groups: [{ groupId: groupId('2'), relationType: 'main', isPrimary: true }],
      },
      requestId: 'request-1',
    });

    expect(notifications.orderCalls).toEqual([{
      sourceId: 'order-group-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      facts: [
        { orderId: '15', groupId: groupId('2'), action: 'added' },
        { orderId: '15', groupId: groupId('1'), action: 'removed' },
      ],
    }]);
  });

  it('does not notify when P8 gate is disabled', async () => {
    const notifications = fakeNotifications();
    const service = new OrderGroupLinkService({
      links: fakeLinks(),
      groupNotifications: notifications,
      groupP8NotificationsEnabled: false,
    });

    await service.replace({
      currentUser: user(['groups.manage_links']),
      orderId: 15,
      dto: { idempotencyKey: 'k1', version: 1, groups: [] },
    });

    expect(notifications.orderCalls).toEqual([]);
  });

  it('uses persisted P8 facts from an idempotent response even when current links already match', async () => {
    const notifications = fakeNotifications();
    const service = new OrderGroupLinkService({
      links: fakeLinks({
        beforeGroupIds: [groupId('2')],
        afterGroupIds: [groupId('2')],
        p8NotificationFacts: [{ orderId: '15', groupId: groupId('2'), action: 'added' }],
      }),
      groupNotifications: notifications,
      groupP8NotificationsEnabled: true,
    });

    const response = await service.replace({
      currentUser: user(['groups.manage_links']),
      orderId: 15,
      dto: {
        idempotencyKey: 'order-group-command-1',
        version: 1,
        groups: [{ groupId: groupId('2'), relationType: 'main', isPrimary: true }],
      },
      requestId: 'request-1',
    });

    expect(notifications.orderCalls).toEqual([{
      sourceId: 'order-group-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      facts: [{ orderId: '15', groupId: groupId('2'), action: 'added' }],
    }]);
    expect(response).not.toHaveProperty('p8NotificationFacts');
  });
});

function fakeLinks(input: {
  beforeGroupIds?: string[];
  afterGroupIds?: string[];
  p8NotificationFacts?: Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }>;
} = {}): OrderGroupLinkRepositoryPort {
  return {
    async getOrderGroups(command) {
      return {
        orderId: command.orderId,
        version: 1,
        primaryGroup: null,
        groups: (input.beforeGroupIds ?? [groupId('1')]).map(groupSummary),
        requestId: command.requestId ?? 'request-id',
      };
    },
    async replaceOrderGroups(command) {
      return {
        orderId: command.orderId,
        version: 2,
        primaryGroup: null,
        groups: (input.afterGroupIds ?? [groupId('2')]).map(groupSummary),
        requestId: command.requestId ?? 'request-id',
        changed: true,
        ...(input.p8NotificationFacts ? { p8NotificationFacts: input.p8NotificationFacts } : {}),
      };
    },
  };
}

function fakeNotifications() {
  return {
    orderCalls: [] as unknown[],
    async handleGroupOrderLinksChanged(input: unknown) {
      this.orderCalls.push(input);
      return [];
    },
  } as never;
}

function groupSummary(id: string) {
  return {
    id,
    code: `P-${id}`,
    name: `Group ${id}`,
    relationType: 'main' as const,
    isPrimary: true,
    validFrom: '2026-06-05T00:00:00.000Z',
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions };
}

function groupId(suffix: string): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}
