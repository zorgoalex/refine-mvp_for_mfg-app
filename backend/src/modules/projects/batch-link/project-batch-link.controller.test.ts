import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { ProjectsRuntimeConfigService } from '../projects-runtime-config.service';
import { ProjectBatchLinkController } from './project-batch-link.controller';
import type { ProjectBatchLinkService } from './project-batch-link.service';

const projectId = '11111111-1111-4111-8111-111111111111';

describe('ProjectBatchLinkController', () => {
  it('allows dry-run when Projects is read-only', async () => {
    const controller = createController({ projectsEnabled: true, projectsReadOnly: true }, {
      async dryRun(command) {
        return {
          projectId: command.projectId,
          mode: 'dry-run',
          summary: { proposed: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 0 },
          proposals: [],
          skipped: [],
          sampleEvidence: [],
          writeEnabled: false,
        };
      },
    });

    await expect(controller.dryRun(request(), projectId, body())).resolves.toMatchObject({
      projectId,
      mode: 'dry-run',
      writeEnabled: false,
    });
  });

  it('returns 503 when Projects is disabled', async () => {
    const controller = createController({ projectsEnabled: false, projectsReadOnly: true });

    await expect(controller.dryRun(request(), projectId, body())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('rejects unauthenticated requests before service execution', async () => {
    const controller = createController({ projectsEnabled: true, projectsReadOnly: true });

    await expect(controller.dryRun({}, projectId, body())).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects non-dry-run mode with writeEnabled=false details', async () => {
    const controller = createController({ projectsEnabled: true, projectsReadOnly: false });

    await expect(controller.dryRun(request(), projectId, {
      ...body(),
      mode: 'write',
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: { writeEnabled: false },
    });
  });
});

function createController(
  flags: { projectsEnabled: boolean; projectsReadOnly: boolean },
  service: Partial<ProjectBatchLinkService> = {},
): ProjectBatchLinkController {
  return new ProjectBatchLinkController(
    {
      async dryRun() {
        throw new ApiError(500, 'UNEXPECTED', 'service should be overridden');
      },
      ...service,
    } as ProjectBatchLinkService,
    {
      getFeatureFlags() {
        return flags;
      },
    } as ProjectsRuntimeConfigService,
  );
}

function request(): RequestWithCurrentUser {
  return {
    requestId: 'req-1',
    user: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: ['projects.manage_links', 'orders.view'] },
  };
}

function body() {
  return {
    mode: 'dry-run',
    fixtureKey: 'projects-backfill-admin-2026-06-06',
    idempotencyKey: 'projects-backfill-admin-2026-06-06:dry-run:001',
    entityType: 'order',
    source: { type: 'operator_csv', reference: 'reviewed-input-001' },
    items: [],
  };
}
