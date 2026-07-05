import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { GroupsRuntimeConfigService } from '../groups-runtime-config.service';
import { GroupBatchLinkController } from './group-batch-link.controller';
import type { GroupBatchLinkService } from './group-batch-link.service';

const groupId = '11111111-1111-4111-8111-111111111111';

describe('GroupBatchLinkController', () => {
  it('allows dry-run when Groups is read-only', async () => {
    const controller = createController({ groupsEnabled: true, groupsReadOnly: true }, {
      async dryRun(command) {
        return {
          groupId: command.groupId,
          mode: 'dry-run',
          summary: { proposed: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 0 },
          proposals: [],
          skipped: [],
          sampleEvidence: [],
          writeEnabled: false,
        };
      },
    });

    await expect(controller.dryRun(request(), groupId, body())).resolves.toMatchObject({
      groupId,
      mode: 'dry-run',
      writeEnabled: false,
    });
  });

  it('returns 503 when Groups is disabled', async () => {
    const controller = createController({ groupsEnabled: false, groupsReadOnly: true });

    await expect(controller.dryRun(request(), groupId, body())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('rejects unauthenticated requests before service execution', async () => {
    const controller = createController({ groupsEnabled: true, groupsReadOnly: true });

    await expect(controller.dryRun({}, groupId, body())).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects write mode when the explicit write gate is disabled', async () => {
    const controller = createController({
      groupsEnabled: true,
      groupsReadOnly: false,
      groupsBatchLinkWriteEnabled: false,
    });

    await expect(controller.dryRun(request(), groupId, {
      ...body(),
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { writeEnabled: false },
    });
  });

  it('dispatches write mode only when the explicit gate is enabled', async () => {
    const controller = createController(
      { groupsEnabled: true, groupsReadOnly: false, groupsBatchLinkWriteEnabled: true },
      {
        async write(command) {
          return {
            groupId: command.groupId,
            mode: 'write',
            summary: { proposed: 0, created: 0, existing: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 0 },
            proposals: [],
            created: [],
            existing: [],
            skipped: [],
            sampleEvidence: [],
            changed: false,
            auditId: null,
            outboxEventId: null,
            requestId: command.requestId ?? null,
            writeEnabled: true,
          };
        },
      },
    );

    await expect(controller.dryRun(request(), groupId, {
      ...body(),
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
    })).resolves.toMatchObject({
      groupId,
      mode: 'write',
      writeEnabled: true,
    });
  });
});

function createController(
  flags: {
    groupsEnabled: boolean;
    groupsReadOnly: boolean;
    groupsBatchLinkWriteEnabled?: boolean;
  },
  service: Partial<GroupBatchLinkService> = {},
): GroupBatchLinkController {
  return new GroupBatchLinkController(
    {
      async dryRun() {
        throw new ApiError(500, 'UNEXPECTED', 'service should be overridden');
      },
      ...service,
    } as GroupBatchLinkService,
    {
      getFeatureFlags() {
        return {
          groupP8NotificationsEnabled: false,
          groupsBatchLinkWriteEnabled: false,
          ...flags,
        };
      },
    } as GroupsRuntimeConfigService,
  );
}

function request(): RequestWithCurrentUser {
  return {
    requestId: 'req-1',
    user: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: ['groups.manage_links', 'orders.view'] },
  };
}

function body() {
  return {
    mode: 'dry-run',
    fixtureKey: 'groups-backfill-admin-2026-06-06',
    idempotencyKey: 'groups-backfill-admin-2026-06-06:dry-run:001',
    entityType: 'order',
    relationType: 'related',
    source: { type: 'operator_csv', reference: 'reviewed-input-001' },
    items: [],
  };
}
