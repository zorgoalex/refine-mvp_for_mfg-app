import { describe, expect, it } from 'vitest';
import { GroupParticipantsController } from './group-participants.controller';

describe('GroupParticipantsController', () => {
  it('fails closed when groups are disabled', async () => {
    const controller = controllerWithFlags({ groupsEnabled: false, groupsReadOnly: false });

    await expect(controller.list(request(), groupId())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('blocks participant writes in read-only mode but allows role reads', async () => {
    const controller = controllerWithFlags({ groupsEnabled: true, groupsReadOnly: true });

    await expect(controller.replace(request(), groupId(), validBody())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(controller.roles(request())).resolves.toMatchObject({
      roles: [{ code: 'manager', label: 'Manager' }],
    });
  });

  it('returns 400 for invalid groupId and 422 for invalid DTO', async () => {
    const controller = controllerWithFlags({ groupsEnabled: true, groupsReadOnly: false });

    await expect(controller.list(request(), 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
    await expect(controller.replace(request(), groupId(), { idempotencyKey: '', participants: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });
});

function controllerWithFlags(flags: { groupsEnabled: boolean; groupsReadOnly: boolean }) {
  return new GroupParticipantsController(
    {
      list: async (command) => ({ groupId: command.groupId, participants: [], requestId: 'request-id' }),
      replace: async (command) => ({ groupId: command.groupId, participants: [], requestId: 'request-id' }),
      roles: async () => ({ roles: [{ code: 'manager', label: 'Manager' }], requestId: 'request-id' }),
    } as never,
    { getFeatureFlags: () => flags } as never,
    { canUser: () => false } as never,
  );
}

function validBody() {
  return {
    idempotencyKey: 'key-1',
    participants: [{ participantType: 'employee', participantId: '77', roleCode: 'manager', metadata: {} }],
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
