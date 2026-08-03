import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderRealtimeSnapshotService } from './order-realtime-snapshot.service';

const user: CurrentUser = {
  id: '17',
  username: 'manager',
  role: 'manager',
  roleId: 4,
  permissions: ['orders.view', 'cut.view'],
};

describe('OrderRealtimeSnapshotService', () => {
  it('projects counters into the permission-safe cursor and stable ETag', async () => {
    const reader = {
      authorize: async () => ({ currentUser: user, cutRefsAllowed: true, permissionVariant: 'status_cut' }),
      loadSnapshot: async () => ({
        commitSequence: 99,
        detailStatusRevision: 12,
        cutRefsRevision: 7,
        details: [{ detailId: 1, productionStatusId: 4, cutJob: null, bathCutJob: null }],
      }),
    };
    const runtime = {
      snapshotEnabled: true,
      isStreamEnabledForUser: async () => true,
    };
    const service = new OrderRealtimeSnapshotService(reader as any, runtime as any);

    const first = await service.getSnapshot({ tokenUser: user, orderId: 42 });
    const second = await service.getSnapshot({ tokenUser: user, orderId: 42 });

    expect(first.streamCursor).toBe('v1;s=12;c=7');
    expect(first.etag).toBe(second.etag);
    expect(JSON.stringify(first)).not.toContain('99');
  });

  it('does not expose the cut counter to a status-only user', async () => {
    const reader = {
      authorize: async () => ({ currentUser: user, cutRefsAllowed: false, permissionVariant: 'status' }),
      loadSnapshot: async () => ({
        commitSequence: 100,
        detailStatusRevision: 12,
        cutRefsRevision: 88,
        details: [{ detailId: 1, productionStatusId: 4 }],
      }),
    };
    const service = new OrderRealtimeSnapshotService(reader as any, {
      snapshotEnabled: true,
      isStreamEnabledForUser: async () => true,
    } as any);

    const snapshot = await service.getSnapshot({ tokenUser: user, orderId: 42 });

    expect(snapshot.streamCursor).toBe('v1;s=12');
    expect(JSON.stringify(snapshot)).not.toContain('88');
  });
});
