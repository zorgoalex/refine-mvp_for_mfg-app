import { describe, expect, it } from 'vitest';
import { ProjectParticipantsController } from './project-participants.controller';

describe('ProjectParticipantsController', () => {
  it('fails closed when projects are disabled', async () => {
    const controller = controllerWithFlags({ projectsEnabled: false, projectsReadOnly: false });

    await expect(controller.list(request(), projectId())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('blocks participant writes in read-only mode but allows role reads', async () => {
    const controller = controllerWithFlags({ projectsEnabled: true, projectsReadOnly: true });

    await expect(controller.replace(request(), projectId(), validBody())).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(controller.roles(request())).resolves.toMatchObject({
      roles: [{ code: 'manager', label: 'Manager' }],
    });
  });

  it('returns 400 for invalid projectId and 422 for invalid DTO', async () => {
    const controller = controllerWithFlags({ projectsEnabled: true, projectsReadOnly: false });

    await expect(controller.list(request(), 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
    await expect(controller.replace(request(), projectId(), { idempotencyKey: '', participants: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });
});

function controllerWithFlags(flags: { projectsEnabled: boolean; projectsReadOnly: boolean }) {
  return new ProjectParticipantsController(
    {
      list: async (command) => ({ projectId: command.projectId, participants: [], requestId: 'request-id' }),
      replace: async (command) => ({ projectId: command.projectId, participants: [], requestId: 'request-id' }),
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

function projectId(): string {
  return '11111111-1111-4111-8111-111111111111';
}
