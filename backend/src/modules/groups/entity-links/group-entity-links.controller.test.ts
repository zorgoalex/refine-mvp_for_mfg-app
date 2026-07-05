import { describe, expect, it } from 'vitest';
import { GroupEntityLinksController } from './group-entity-links.controller';

describe('GroupEntityLinksController', () => {
  it('fails closed when groups are disabled', async () => {
    const controller = controllerWithFlags({ groupsEnabled: false, groupsReadOnly: false });

    await expect(controller.list(request(), groupId(), {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('blocks writes in read-only mode', async () => {
    const controller = controllerWithFlags({ groupsEnabled: true, groupsReadOnly: true });

    await expect(controller.replace(request(), groupId(), validBody())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 400 for invalid groupId and 422 for invalid DTO', async () => {
    const controller = controllerWithFlags({ groupsEnabled: true, groupsReadOnly: false });

    await expect(controller.list(request(), 'not-a-uuid', {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
    await expect(controller.replace(request(), groupId(), { idempotencyKey: '', links: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });
});

function controllerWithFlags(flags: { groupsEnabled: boolean; groupsReadOnly: boolean }) {
  return new GroupEntityLinksController(
    {
      list: async (command) => ({ groupId: command.groupId, links: [], requestId: 'request-id' }),
      replace: async (command) => ({ groupId: command.groupId, links: [], requestId: 'request-id' }),
      append: async (command) => ({ groupId: command.groupId, links: [], requestId: 'request-id' }),
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

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
