import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import * as auditServiceModule from '../../../common/audit/audit.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import { GroupBatchLinkService, type GroupBatchLinkRepositoryPort } from './group-batch-link.service';

const groupId = '11111111-1111-4111-8111-111111111111';

/** Minimal stub for DatabaseService used in audit sink tests */
function mockDatabase() {
  return { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'test-audit-id' }] }) } as any;
}

describe('GroupBatchLinkService', () => {
  it('requires groups.manage_links and admin/top_manager role only', async () => {
    const service = new GroupBatchLinkService({
      batchLinks: repository(),
      database: mockDatabase(),
    });

    await expect(service.dryRun(command({
      currentUser: user('superadmin', ['groups.manage_links', 'orders.view']),
    }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    await expect(service.dryRun(command({
      currentUser: user('admin', ['orders.view']),
    }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('requires entity-specific view permission', async () => {
    const service = new GroupBatchLinkService({
      batchLinks: repository(),
      database: mockDatabase(),
    });

    await expect(service.dryRun(command({
      currentUser: user('admin', ['groups.manage_links']),
    }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('returns dry-run proposals without write side effects', async () => {
    const service = new GroupBatchLinkService({
      batchLinks: repository({
        async dryRun(input) {
          return {
            groupId: input.groupId,
            mode: 'dry-run',
            summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
            proposals: [{
              entityType: 'order',
              entityId: '11195',
              action: 'link',
              source: 'operator_csv',
              confidence: 'explicit',
              reason: 'explicit reviewed mapping',
            }],
            skipped: [],
            sampleEvidence: [{
              groupId: input.groupId,
              entityType: 'order',
              entityId: '11195',
              source: 'operator_csv',
              sourceRow: 'reviewed-input-001:row-1',
              reason: 'explicit reviewed mapping',
              skipReason: null,
              fixtureKey: input.dto.fixtureKey,
              idempotencyKey: input.dto.idempotencyKey,
              requestId: input.requestId ?? null,
              actorUserId: input.currentUser.id,
              actorUsername: input.currentUser.username,
            }],
            writeEnabled: false,
          };
        },
      }),
      database: mockDatabase(),
    });

    await expect(service.dryRun(command())).resolves.toMatchObject({
      groupId,
      mode: 'dry-run',
      summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
      writeEnabled: false,
    });
  });

  it('allows top_manager with groups.manage_links and entity view permission', async () => {
    const service = new GroupBatchLinkService({
      batchLinks: repository({
        async dryRun(input) {
          return {
            groupId: input.groupId,
            mode: 'dry-run',
            summary: { proposed: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 0 },
            proposals: [],
            skipped: [],
            sampleEvidence: [],
            writeEnabled: false,
          };
        },
      }),
      database: mockDatabase(),
    });

    await expect(service.dryRun(command({
      currentUser: user('top_manager', ['groups.manage_links', 'orders.view']),
    }))).resolves.toMatchObject({
      groupId,
      mode: 'dry-run',
      writeEnabled: false,
    });
  });

  describe('role-denied audit', () => {
    it('writes one audit row with allowedRoles when role check fails', async () => {
      const auditRows: any[] = [];
      vi.spyOn(auditServiceModule.auditService, 'recordDenied').mockImplementation(async (_client, event) => {
        auditRows.push(event);
        return 'audit-id-1';
      });

      const service = new GroupBatchLinkService({
        batchLinks: repository(),
        database: mockDatabase(),
      });

      await expect(service.dryRun(command({
        currentUser: user('manager', ['groups.manage_links', 'orders.view']),
      }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        event: 'group_batch_link.role_denied',
        reason: 'role_denied',
        metadata: { allowedRoles: expect.arrayContaining(['admin', 'top_manager']) },
      });

      vi.restoreAllMocks();
    });

    it('writes zero audit rows when role check passes (permitted path)', async () => {
      const auditRows: any[] = [];
      vi.spyOn(auditServiceModule.auditService, 'recordDenied').mockImplementation(async (_client, event) => {
        auditRows.push(event);
        return 'audit-id-2';
      });

      const service = new GroupBatchLinkService({
        batchLinks: repository({
          async dryRun(input) {
            return {
              groupId: input.groupId,
              mode: 'dry-run',
              summary: { proposed: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 0 },
              proposals: [], skipped: [], sampleEvidence: [], writeEnabled: false,
            };
          },
        }),
        database: mockDatabase(),
      });

      await service.dryRun(command({
        currentUser: user('admin', ['groups.manage_links', 'orders.view']),
      }));

      expect(auditRows).toHaveLength(0);

      vi.restoreAllMocks();
    });

    it('still throws PERMISSION_DENIED even if audit sink throws', async () => {
      vi.spyOn(auditServiceModule.auditService, 'recordDenied').mockRejectedValue(new Error('DB down'));

      const service = new GroupBatchLinkService({
        batchLinks: repository(),
        database: mockDatabase(),
      });

      await expect(service.dryRun(command({
        currentUser: user('director', ['groups.manage_links', 'orders.view']),
      }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

      vi.restoreAllMocks();
    });
  });
});

function command(overrides: Partial<Parameters<GroupBatchLinkService['dryRun']>[0]> = {}) {
  return {
    currentUser: user('admin', ['groups.manage_links', 'orders.view']),
    groupId,
    requestId: 'req-1',
    dto: {
      mode: 'dry-run' as const,
      fixtureKey: 'groups-backfill-admin-2026-06-06',
      idempotencyKey: 'groups-backfill-admin-2026-06-06:dry-run:001',
      entityType: 'order' as const,
      relationType: 'related',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
    },
    ...overrides,
  };
}

function repository(overrides: Partial<GroupBatchLinkRepositoryPort> = {}): GroupBatchLinkRepositoryPort {
  return {
    async dryRun() {
      throw new ApiError(500, 'UNEXPECTED', 'repository should be overridden');
    },
    ...overrides,
  };
}

function user(role: UserRole, permissions: PermissionName[]): CurrentUser {
  return { id: '1', username: 'tester', role, roleId: 1, permissions };
}
