import { describe, expect, it } from 'vitest';
import { ProjectEntityLinksController } from './project-entity-links.controller';

describe('ProjectEntityLinksController', () => {
  it('fails closed when projects are disabled', async () => {
    const controller = controllerWithFlags({ projectsEnabled: false, projectsReadOnly: false });

    await expect(controller.list(request(), projectId(), {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('blocks writes in read-only mode', async () => {
    const controller = controllerWithFlags({ projectsEnabled: true, projectsReadOnly: true });

    await expect(controller.replace(request(), projectId(), validBody())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 400 for invalid projectId and 422 for invalid DTO', async () => {
    const controller = controllerWithFlags({ projectsEnabled: true, projectsReadOnly: false });

    await expect(controller.list(request(), 'not-a-uuid', {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
    await expect(controller.replace(request(), projectId(), { idempotencyKey: '', links: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });
});

function controllerWithFlags(flags: { projectsEnabled: boolean; projectsReadOnly: boolean }) {
  return new ProjectEntityLinksController(
    {
      list: async (command) => ({ projectId: command.projectId, links: [], requestId: 'request-id' }),
      replace: async (command) => ({ projectId: command.projectId, links: [], requestId: 'request-id' }),
      append: async (command) => ({ projectId: command.projectId, links: [], requestId: 'request-id' }),
      visibleEntityTypes: () => ['client'],
    } as never,
    { getFeatureFlags: () => flags } as never,
  );
}

function validBody() {
  return {
    idempotencyKey: 'key-1',
    links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }],
  };
}

function request() {
  return {
    requestId: 'request-id',
    user: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: [] },
  };
}

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
