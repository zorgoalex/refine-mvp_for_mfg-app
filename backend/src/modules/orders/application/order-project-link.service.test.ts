import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { OrderGroupLinkService } from './order-group-link.service';
import type { OrderGroupLinkRepositoryPort } from './order-project-link.types';

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
        idempotencyKey: 'order-project-command-1',
        version: 1,
        projects: [{ projectId: projectId('2'), relationType: 'main', isPrimary: true }],
      },
      requestId: 'request-1',
    });

    expect(notifications.orderCalls).toEqual([{
      sourceId: 'order-project-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      facts: [
        { orderId: '15', groupId: projectId('2'), action: 'added' },
        { orderId: '15', groupId: projectId('1'), action: 'removed' },
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
      dto: { idempotencyKey: 'k1', version: 1, projects: [] },
    });

    expect(notifications.orderCalls).toEqual([]);
  });

  it('uses persisted P8 facts from an idempotent response even when current links already match', async () => {
    const notifications = fakeNotifications();
    const service = new OrderGroupLinkService({
      links: fakeLinks({
        beforeProjectIds: [projectId('2')],
        afterProjectIds: [projectId('2')],
        p8NotificationFacts: [{ orderId: '15', groupId: projectId('2'), action: 'added' }],
      }),
      groupNotifications: notifications,
      groupP8NotificationsEnabled: true,
    });

    const response = await service.replace({
      currentUser: user(['groups.manage_links']),
      orderId: 15,
      dto: {
        idempotencyKey: 'order-project-command-1',
        version: 1,
        projects: [{ projectId: projectId('2'), relationType: 'main', isPrimary: true }],
      },
      requestId: 'request-1',
    });

    expect(notifications.orderCalls).toEqual([{
      sourceId: 'order-project-command-1',
      actorUserId: '1',
      requestId: 'request-1',
      facts: [{ orderId: '15', groupId: projectId('2'), action: 'added' }],
    }]);
    expect(response).not.toHaveProperty('p8NotificationFacts');
  });
});

function fakeLinks(input: {
  beforeProjectIds?: string[];
  afterProjectIds?: string[];
  p8NotificationFacts?: Array<{ orderId: string; groupId: string; action: 'added' | 'removed' }>;
} = {}): OrderGroupLinkRepositoryPort {
  return {
    async getOrderProjects(command) {
      return {
        orderId: command.orderId,
        version: 1,
        primaryProject: null,
        projects: (input.beforeProjectIds ?? [projectId('1')]).map(projectSummary),
        requestId: command.requestId ?? 'request-id',
      };
    },
    async replaceOrderProjects(command) {
      return {
        orderId: command.orderId,
        version: 2,
        primaryProject: null,
        projects: (input.afterProjectIds ?? [projectId('2')]).map(projectSummary),
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

function projectSummary(id: string) {
  return {
    id,
    code: `P-${id}`,
    name: `Project ${id}`,
    relationType: 'main' as const,
    isPrimary: true,
    validFrom: '2026-06-05T00:00:00.000Z',
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions };
}

function projectId(suffix: string): string {
  return `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
}
