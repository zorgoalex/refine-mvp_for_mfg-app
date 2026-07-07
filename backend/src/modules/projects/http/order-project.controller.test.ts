import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { ProjectsService } from '../application/projects.service';
import { OrderProjectController, parseMoveOrderBody } from './order-project.controller';

describe('OrderProjectController', () => {
  it('parseMoveOrderBody rejects XOR violations with 422', () => {
    expect(() => parseMoveOrderBody({ idempotencyKey: 'move-key-1' })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
    );
    expect(() =>
      parseMoveOrderBody({
        targetProjectId: 5,
        createNew: true,
        idempotencyKey: 'move-key-2',
      }),
    ).toThrow(expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }));
  });

  it('delegates POST with parsed dto and requestId', async () => {
    const moveOrder = vi.fn().mockResolvedValue({
      orderId: 10,
      projectId: 200,
      code: 'ФК26',
      archivedSourceProjectId: null,
      auditId: 101,
      requestId: 'req-1',
    });
    const controller = createController({ moveOrder });

    const result = await controller.move(request(), 10, {
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-1',
    });

    expect(moveOrder).toHaveBeenCalledWith({
      currentUser: request().user,
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-1',
      requestId: 'req-1',
    });
    expect(result.projectId).toBe(200);
  });

  it('@HttpCode 200 is declared on move route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, OrderProjectController)).toBe('orders');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, OrderProjectController.prototype.move)).toBe(200);
  });
});

function createController(service?: Partial<Record<'moveOrder', unknown>>) {
  const projects = {
    moveOrder: async () => {
      throw new Error('moveOrder should not be called');
    },
    ...service,
  } as unknown as ProjectsService;

  return new OrderProjectController(projects);
}

function request(): RequestWithCurrentUser {
  return {
    user: {
      id: '7',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: ['projects.manage'],
    },
    requestId: 'req-1',
  };
}
