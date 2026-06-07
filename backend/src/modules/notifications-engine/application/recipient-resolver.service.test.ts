import { describe, expect, it, vi } from 'vitest';
import type { NotificationEventContext, NotificationRuleRecipients } from '../domain/notification-rule.types';
import type { RecipientSourcePort } from '../ports/recipient-source.port';
import type { VisibilityPort } from '../ports/visibility.port';
import { RecipientResolverService } from './recipient-resolver.service';

describe('RecipientResolverService', () => {
  it('resolves, dedupes, filters active users, and applies base visibility', async () => {
    const sources = fakeSources({
      resolveDynamic: vi.fn(async () => [10]),
      resolveRoleMembers: vi.fn(async () => [20, 10]),
      filterActiveUsers: vi.fn(async (_client, userIds: number[]) => userIds),
    });
    const visibility = fakeVisibility({
      filterByBaseVisibility: vi.fn(async (_client, userIds: number[]) => userIds.filter((id) => id !== 20)),
    });
    const service = new RecipientResolverService(sources, visibility);

    const recipients: NotificationRuleRecipients = {
      resolvers: ['order_manager'],
      roleCodes: ['admin'],
      userIds: [7],
    };

    const result = await service.resolve({} as any, recipients, ctx());

    expect([...result].sort((a, b) => a - b)).toEqual([7, 10]);
    expect(result).toHaveLength(2);

    expect(sources.resolveDynamic).toHaveBeenCalledTimes(1);
    expect(sources.resolveDynamic).toHaveBeenCalledWith({}, 'order_manager', expect.anything());
    expect(sources.resolveRoleMembers).toHaveBeenCalledTimes(1);
    expect(sources.resolveRoleMembers).toHaveBeenCalledWith({}, ['admin']);

    const activeArgs = (sources.filterActiveUsers as ReturnType<typeof vi.fn>).mock.calls[0][1] as number[];
    expect([...activeArgs].sort((a, b) => a - b)).toEqual([7, 10, 20]);

    const visibilityArgs = (visibility.filterByBaseVisibility as ReturnType<typeof vi.fn>).mock.calls[0][1] as number[];
    expect([...visibilityArgs].sort((a, b) => a - b)).toEqual([7, 10, 20]);
  });

  it('returns empty array for empty recipients without calling active/visibility filters', async () => {
    const sources = fakeSources();
    const visibility = fakeVisibility();
    const service = new RecipientResolverService(sources, visibility);

    const result = await service.resolve({} as any, {}, ctx());

    expect(result).toEqual([]);
    expect(sources.resolveDynamic).not.toHaveBeenCalled();
    expect(sources.resolveRoleMembers).not.toHaveBeenCalled();
    expect(sources.filterActiveUsers).not.toHaveBeenCalled();
    expect(visibility.filterByBaseVisibility).not.toHaveBeenCalled();
  });

  it('dedupes ids appearing in both resolver and role member results', async () => {
    const sources = fakeSources({
      resolveDynamic: vi.fn(async () => [10, 11]),
      resolveRoleMembers: vi.fn(async () => [10, 12]),
      filterActiveUsers: vi.fn(async (_client, userIds: number[]) => userIds),
    });
    const visibility = fakeVisibility({
      filterByBaseVisibility: vi.fn(async (_client, userIds: number[]) => userIds),
    });
    const service = new RecipientResolverService(sources, visibility);

    const recipients: NotificationRuleRecipients = {
      resolvers: ['order_manager'],
      roleCodes: ['admin'],
    };

    const result = await service.resolve({} as any, recipients, ctx());

    expect([...result].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    const activeArgs = (sources.filterActiveUsers as ReturnType<typeof vi.fn>).mock.calls[0][1] as number[];
    expect(activeArgs.filter((id) => id === 10)).toHaveLength(1);
  });
});

function ctx(): NotificationEventContext {
  return {
    eventType: 'order.production_status_changed',
    orderId: 42,
  } as unknown as NotificationEventContext;
}

function fakeSources(overrides: Partial<RecipientSourcePort> = {}): RecipientSourcePort {
  return {
    resolveDynamic: vi.fn(async () => []),
    resolveRoleMembers: vi.fn(async () => []),
    filterActiveUsers: vi.fn(async () => []),
    ...overrides,
  };
}

function fakeVisibility(overrides: Partial<VisibilityPort> = {}): VisibilityPort {
  return {
    filterByBaseVisibility: vi.fn(async () => []),
    ...overrides,
  };
}
