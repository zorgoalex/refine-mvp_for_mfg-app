import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { ProjectsService } from '../application/projects.service';
import { ProjectsController, parseListProjectsQuery, parseMergeBody, parseUpdateProjectBody } from './projects.controller';

describe('ProjectsController', () => {
  it('rejects unauthenticated list requests with 401', async () => {
    const controller = createController();

    expect(() => controller.list({ requestId: 'req-1' }, {})).toThrow(
      expect.objectContaining({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
      }),
    );
  });

  it('parseUpdateProjectBody rejects payload without mutable fields', () => {
    expect(() => parseUpdateProjectBody({ expectedVersion: 0 })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
    );
  });

  it('parseListProjectsQuery coerces numeric and boolean params', () => {
    expect(parseListProjectsQuery({ clientId: '9', includeArchived: 'true', search: ' ФК ' })).toMatchObject({
      clientId: 9,
      includeArchived: true,
      search: 'ФК',
    });
  });

  it('delegates PATCH with parsed dto and requestId', async () => {
    const update = vi.fn().mockResolvedValue({
      projectId: 5,
      code: 'ФК26',
      name: 'Кухня',
      clientId: 9,
      notes: null,
      version: 3,
    });
    const controller = createController({ update });

    const result = await controller.update(request(), 5, {
      code: 'ФК26',
      notes: null,
      expectedVersion: 2,
    });

    expect(update).toHaveBeenCalledWith({
      currentUser: request().user,
      projectId: 5,
      dto: {
        code: 'ФК26',
        notes: null,
      },
      expectedVersion: 2,
      requestId: 'req-1',
    });
    expect(result.code).toBe('ФК26');
  });

  it('parseMergeBody rejects invalid payload with 422', () => {
    expect(() => parseMergeBody({ idempotencyKey: 'short' })).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_ERROR' }),
    );
  });

  it('delegates POST merge with parsed dto and requestId', async () => {
    const merge = vi.fn().mockResolvedValue({
      targetProjectId: 200,
      sourceProjectId: 100,
      movedOrdersCount: 3,
      auditId: 101,
      requestId: 'req-1',
    });
    const controller = createController({ merge });

    const result = await controller.merge(request(), 200, {
      sourceProjectId: 100,
      idempotencyKey: 'merge-key-123',
    });

    expect(merge).toHaveBeenCalledWith({
      currentUser: request().user,
      targetProjectId: 200,
      sourceProjectId: 100,
      idempotencyKey: 'merge-key-123',
      requestId: 'req-1',
    });
    expect(result.movedOrdersCount).toBe(3);
  });

  it('@HttpCode 200 is declared on merge route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ProjectsController)).toBe('projects');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ProjectsController.prototype.merge)).toBe(200);
  });
});

function createController(service?: Partial<Record<'list' | 'getById' | 'update' | 'merge', unknown>>) {
  const projects = {
    list: async () => [],
    getById: async () => {
      throw new Error('getById should not be called');
    },
    update: async () => {
      throw new Error('update should not be called');
    },
    merge: async () => {
      throw new Error('merge should not be called');
    },
    ...service,
  } as unknown as ProjectsService;

  return new ProjectsController(projects);
}

function request(): RequestWithCurrentUser {
  return {
    user: {
      id: '7',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: ['projects.view', 'projects.manage'],
    },
    requestId: 'req-1',
  };
}
