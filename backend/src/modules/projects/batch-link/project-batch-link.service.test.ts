import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import { ProjectBatchLinkService, type ProjectBatchLinkRepositoryPort } from './project-batch-link.service';

const projectId = '11111111-1111-4111-8111-111111111111';

describe('ProjectBatchLinkService', () => {
  it('requires projects.manage_links and admin/top_manager role only', async () => {
    const service = new ProjectBatchLinkService({
      batchLinks: repository(),
    });

    await expect(service.dryRun(command({
      currentUser: user('superadmin', ['projects.manage_links', 'orders.view']),
    }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    await expect(service.dryRun(command({
      currentUser: user('admin', ['orders.view']),
    }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('requires entity-specific view permission', async () => {
    const service = new ProjectBatchLinkService({
      batchLinks: repository(),
    });

    await expect(service.dryRun(command({
      currentUser: user('admin', ['projects.manage_links']),
    }))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('returns dry-run proposals without write side effects', async () => {
    const service = new ProjectBatchLinkService({
      batchLinks: repository({
        async dryRun(input) {
          return {
            projectId: input.projectId,
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
              projectId: input.projectId,
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
    });

    await expect(service.dryRun(command())).resolves.toMatchObject({
      projectId,
      mode: 'dry-run',
      summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
      writeEnabled: false,
    });
  });

  it('allows top_manager with projects.manage_links and entity view permission', async () => {
    const service = new ProjectBatchLinkService({
      batchLinks: repository({
        async dryRun(input) {
          return {
            projectId: input.projectId,
            mode: 'dry-run',
            summary: { proposed: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 0 },
            proposals: [],
            skipped: [],
            sampleEvidence: [],
            writeEnabled: false,
          };
        },
      }),
    });

    await expect(service.dryRun(command({
      currentUser: user('top_manager', ['projects.manage_links', 'orders.view']),
    }))).resolves.toMatchObject({
      projectId,
      mode: 'dry-run',
      writeEnabled: false,
    });
  });
});

function command(overrides: Partial<Parameters<ProjectBatchLinkService['dryRun']>[0]> = {}) {
  return {
    currentUser: user('admin', ['projects.manage_links', 'orders.view']),
    projectId,
    requestId: 'req-1',
    dto: {
      mode: 'dry-run' as const,
      fixtureKey: 'projects-backfill-admin-2026-06-06',
      idempotencyKey: 'projects-backfill-admin-2026-06-06:dry-run:001',
      entityType: 'order' as const,
      relationType: 'related',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
    },
    ...overrides,
  };
}

function repository(overrides: Partial<ProjectBatchLinkRepositoryPort> = {}): ProjectBatchLinkRepositoryPort {
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
