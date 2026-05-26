import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import type { ProjectDto, ProjectListResponseDto } from './dto/project.dto';
import { ProjectNotFoundError, ProjectsService, type ProjectRepositoryPort } from './projects.service';

describe('ProjectsService', () => {
  it('requires projects.view before listing projects', async () => {
    const service = new ProjectsService({ projects: createRepository() });

    await expect(
      service.list({ currentUser: currentUser('operator'), query: { page: 1, pageSize: 25 } }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['projects.view'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates read methods for users with projects.view', async () => {
    const project = projectDto();
    const listResponse: ProjectListResponseDto = {
      data: [project],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    const calls: string[] = [];
    const service = new ProjectsService({
      projects: createRepository({
        async listProjects(query) {
          calls.push(`list:${query.page}`);
          return listResponse;
        },
        async lookupProjects(query) {
          calls.push(`lookup:${query.search ?? ''}:${query.limit}`);
          return { data: [{ id: project.id, code: project.code, name: project.name, status: project.status }] };
        },
        async getProjectById(projectId) {
          calls.push(`get:${projectId}`);
          return project;
        },
      }),
    });

    await expect(
      service.list({ currentUser: currentUser('manager'), query: { page: 1, pageSize: 25 } }),
    ).resolves.toEqual(listResponse);
    await expect(
      service.lookup({ currentUser: currentUser('viewer'), query: { search: 'prj', limit: 10 } }),
    ).resolves.toEqual({ data: [{ id: project.id, code: project.code, name: project.name, status: project.status }] });
    await expect(
      service.getById({ currentUser: currentUser('top_manager'), projectId: project.id }),
    ).resolves.toEqual(project);
    expect(calls).toEqual(['list:1', 'lookup:prj:10', `get:${project.id}`]);
  });

  it('maps missing projects to ProjectNotFoundError', async () => {
    const service = new ProjectsService({ projects: createRepository({ async getProjectById() { return null; } }) });

    await expect(
      service.getById({
        currentUser: currentUser('manager'),
        projectId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

function createRepository(overrides: Partial<ProjectRepositoryPort> = {}): ProjectRepositoryPort {
  return {
    async listProjects() {
      throw new Error('listProjects should not be called');
    },
    async lookupProjects() {
      throw new Error('lookupProjects should not be called');
    },
    async getProjectById() {
      throw new Error('getProjectById should not be called');
    },
    ...overrides,
  };
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
