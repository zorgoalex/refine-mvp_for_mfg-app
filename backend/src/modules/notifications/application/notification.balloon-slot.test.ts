import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { NotificationService } from './notification.service';
import type { NotificationRepositoryPort } from './notification.types';

describe('NotificationService balloon claim with slots (18.11.2026)', () => {
  const user = { id: '42', username: 'u', role: 'manager', roleId: 10, permissions: [] } as unknown as CurrentUser;
  const token = '22222222-2222-4222-8222-222222222222';
  const open = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'];

  it('limit 0 claims nothing and only answers which open balloons were replaced', async () => {
    const claim = vi.fn(async () => []);
    const superseded = vi.fn(async () => [open[0]]);
    const service = new NotificationService({ repository: { claimBalloonsForUser: claim, supersededBalloonsForUser: superseded } as unknown as NotificationRepositoryPort });
    expect(await service.claimBalloons({ currentUser: user, token, limit: 0, openNotificationIds: [...open, open[0]] }))
      .toEqual({ items: [], superseded: [open[0]] });
    expect(claim).not.toHaveBeenCalled();
    expect(superseded).toHaveBeenCalledWith({ viewer: user, notificationIds: open });
  });

  it('without open balloons no superseded lookup; invalid ids are refused', async () => {
    const superseded = vi.fn(async () => []);
    const service = new NotificationService({ repository: { claimBalloonsForUser: async () => [], supersededBalloonsForUser: superseded } as unknown as NotificationRepositoryPort });
    expect(await service.claimBalloons({ currentUser: user, token, limit: 2 })).toEqual({ items: [], superseded: [] });
    expect(superseded).not.toHaveBeenCalled();
    await expect(service.claimBalloons({ currentUser: user, token, limit: 1, openNotificationIds: ['bad'] })).rejects.toMatchObject({ statusCode: 400 });
  });
});
