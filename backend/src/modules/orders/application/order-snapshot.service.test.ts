import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ApiError } from '../../../common/errors/api-error';
import { ORDER_SNAPSHOT_FORMAT_VERSION, ORDER_SNAPSHOT_SCHEMA } from '../dto/order-snapshot.dto';
import type { OrderSnapshotPort } from './order-snapshot.types';
import { OrderSnapshotService } from './order-snapshot.service';

describe('OrderSnapshotService', () => {
  it('requires orders.export for snapshot export', async () => {
    const snapshots = fakeSnapshots();
    const service = new OrderSnapshotService({ snapshots });

    expect(() =>
      service.exportOrderSnapshot({
        currentUser: viewer(),
        orderId: 10,
      }),
    ).toThrowError(ApiError);
    expect(snapshots.exportOrderSnapshot).not.toHaveBeenCalled();
  });

  it('requires orders.import for snapshot import', async () => {
    const snapshots = fakeSnapshots();
    const service = new OrderSnapshotService({ snapshots });

    expect(() =>
      service.importOrderSnapshot({
        currentUser: viewer(),
        snapshot: minimalSnapshot(),
      }),
    ).toThrowError(ApiError);
    expect(snapshots.importOrderSnapshot).not.toHaveBeenCalled();
  });

  it('delegates export/import for users with permissions', async () => {
    const snapshots = fakeSnapshots();
    const service = new OrderSnapshotService({ snapshots });
    const currentUser = manager();

    await expect(service.exportOrderSnapshot({ currentUser, orderId: 10 })).resolves.toEqual({
      fileName: 'order.erp-order.json',
      content: '{}',
    });
    await expect(
      service.importOrderSnapshot({ currentUser, snapshot: minimalSnapshot() }),
    ).resolves.toMatchObject({
      success: true,
      status: 'created',
      orderId: 10,
    });
  });
});

function fakeSnapshots(): OrderSnapshotPort {
  return {
    exportOrderSnapshot: vi.fn(async () => ({ fileName: 'order.erp-order.json', content: '{}' })),
    exportOrderSnapshotBatch: vi.fn(async () => ({
      fileName: 'orders.erp-order-batch.zip',
      content: Buffer.from([]),
      orderCount: 0,
    })),
    importOrderSnapshot: vi.fn(async () => ({
      success: true,
      status: 'created',
      orderId: 10,
      orderName: 'A-10',
      payloadHash: 'hash',
      importRunId: 'run',
      summary: {
        details: 0,
        payments: 0,
        workshops: 0,
        requirements: 0,
        dowelingLinks: 0,
        productionStatusEvents: 0,
        clientPhones: 0,
        deadlineInstances: 0,
        deadlineEvents: 0,
      },
    })),
    importOrderSnapshotBatch: vi.fn(async () => ({
      success: true,
      total: 0,
      imported: 0,
      failed: 0,
      results: [],
    })),
  };
}

function manager(): CurrentUser {
  return {
    id: '10',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

function viewer(): CurrentUser {
  return {
    id: '100',
    username: 'viewer',
    role: 'viewer',
    roleId: 100,
    permissions: getPermissionsForRole('viewer'),
  };
}

function minimalSnapshot() {
  return {
    schema: ORDER_SNAPSHOT_SCHEMA,
    formatVersion: ORDER_SNAPSHOT_FORMAT_VERSION,
    exporterService: {
      name: 'erp-order-snapshot' as const,
      version: '1.0.0',
      compatibleImportVersions: ['1.0.0'],
    },
    source: {
      sourceInstanceId: 'test',
      exportedAt: '2026-05-11T00:00:00.000Z',
      payloadHash: '',
    },
    identity: {
      order: { sourceId: '10', refKey1c: null },
      client: { sourceId: '20', refKey1c: null },
    },
    data: {
      client: {
        sourceId: '20',
        clientName: 'Client',
        refKey1c: null,
        notes: null,
        isActive: true,
      },
      clientPhones: [],
      order: {
        sourceId: '10',
        orderName: 'A-10',
        clientId: 20,
        orderDate: '2026-05-11',
        orderStatusId: 1,
      },
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingOrders: [],
      dowelingLinks: [],
      productionStatusEvents: [],
      deadlineInstances: [],
      deadlineEvents: [],
    },
    references: {},
  };
}
