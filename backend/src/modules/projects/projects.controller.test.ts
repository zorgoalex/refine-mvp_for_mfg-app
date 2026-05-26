import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import type { ProjectDto, ProjectListResponseDto } from './dto/project.dto';
import {
  parseProjectId,
  parseProjectListQuery,
  parseProjectLookupQuery,
  ProjectsController,
} from './projects.controller';
import type { ProjectsRuntimeConfigService } from './projects-runtime-config.service';
import type { ProjectsService } from './projects.service';

describe('ProjectsController', () => {
  it('fails closed when projects API is disabled by default', async () => {
    const controller = createController({ flags: { projectsEnabled: false, projectsReadOnly: true } });

    await expect(controller.list({ user: currentUser('manager') }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before service calls', async () => {
    const controller = createController({ flags: { projectsEnabled: true, projectsReadOnly: true } });

    await expect(controller.lookup({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('normalizes list, lookup, and get requests', async () => {
    const project = projectDto();
    const listResponse: ProjectListResponseDto = {
      data: [project],
      pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 },
    };
    const calls: string[] = [];
    const controller = createController({
      flags: { projectsEnabled: true, projectsReadOnly: true },
      service: {
        async list(command) {
          calls.push(`list:${command.query.page}:${command.query.status}:${command.query.ownerUserId}`);
          return listResponse;
        },
        async lookup(command) {
          calls.push(`lookup:${command.query.search}:${command.query.limit}`);
          return { data: [{ id: project.id, code: project.code, name: project.name, status: project.status }] };
        },
        async getById(command) {
          calls.push(`get:${command.projectId}`);
          return project;
        },
      },
    });

    await expect(
      controller.list(
        { user: currentUser('manager') },
        { page: '2', pageSize: '10', search: ' kitchen ', status: 'active', ownerUserId: '7' },
      ),
    ).resolves.toEqual(listResponse);
    await expect(
      controller.lookup({ user: currentUser('viewer') }, { search: ' kitchen ', limit: '5' }),
    ).resolves.toEqual({ data: [{ id: project.id, code: project.code, name: project.name, status: project.status }] });
    await expect(controller.getById({ user: currentUser('admin') }, project.id)).resolves.toEqual({
      project,
    });
    expect(calls).toEqual([`list:2:active:7`, 'lookup:kitchen:5', `get:${project.id}`]);
  });

  it('validates project query values and UUID path params', () => {
    expect(parseProjectId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => parseProjectId('not-a-uuid')).toThrow(ApiError);
    expect(() => parseProjectListQuery({ status: 'unknown' })).toThrow(ApiError);
    expect(() => parseProjectListQuery({ ownerUserId: '0' })).toThrow(ApiError);
    expect(() => parseProjectLookupQuery({ limit: '101' })).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { projectsEnabled: boolean; projectsReadOnly: boolean };
  service?: Partial<ProjectsService>;
}): ProjectsController {
  const service = {
    async list() {
      throw new Error('list should not be called');
    },
    async lookup() {
      throw new Error('lookup should not be called');
    },
    async getById() {
      throw new Error('getById should not be called');
    },
    ...options.service,
  } as unknown as ProjectsService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as ProjectsRuntimeConfigService;

  return new ProjectsController(service, runtimeConfig);
}

function currentUser(role: CurrentUser['role']): CurrentUser {
  return {
    id: `${role}-id`,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}

function projectDto(): ProjectDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'PRJ-001',
    name: 'Project',
    description: null,
    status: 'active',
    startsAt: null,
    endsAt: null,
    ownerUserId: null,
    metadata: {},
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    archivedAt: null,
    createdBy: null,
  };
}
