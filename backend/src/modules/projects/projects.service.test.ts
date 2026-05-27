import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import type {
  CreateProjectRequestDto,
  ProjectMembersResponseDto,
  ProjectDto,
  ProjectListResponseDto,
  UpdateProjectRequestDto,
} from './dto/project.dto';
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

  it('requires project write permissions before delegating create, update, or archive', async () => {
    const service = new ProjectsService({ projects: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.create({
        currentUser: viewer,
        dto: createProjectDto(),
        requestId: 'req-create-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['projects.create'] },
    } satisfies Partial<ApiError>);

    await expect(
      service.update({
        currentUser: viewer,
        projectId: '11111111-1111-4111-8111-111111111111',
        dto: { name: 'Updated project' },
        requestId: 'req-update-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['projects.update'] },
    } satisfies Partial<ApiError>);

    await expect(
      service.archive({
        currentUser: viewer,
        projectId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-archive-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['projects.archive'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates write methods for users with project write permissions', async () => {
    const project = projectDto();
    const calls: string[] = [];
    const service = new ProjectsService({
      projects: createRepository({
        async createProject(command) {
          calls.push(`create:${command.currentUser.id}:${command.dto.code}:${command.requestId}`);
          return project;
        },
        async updateProject(command) {
          calls.push(`update:${command.projectId}:${command.dto.name}:${command.requestId}`);
          return { ...project, name: command.dto.name ?? project.name };
        },
        async archiveProject(command) {
          calls.push(`archive:${command.projectId}:${command.requestId}`);
          return { ...project, status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' };
        },
      }),
    });

    await expect(
      service.create({
        currentUser: currentUser('admin'),
        dto: createProjectDto(),
        requestId: 'req-create-1',
      }),
    ).resolves.toEqual(project);
    await expect(
      service.update({
        currentUser: currentUser('admin'),
        projectId: project.id,
        dto: { name: 'Updated project' } satisfies UpdateProjectRequestDto,
        requestId: 'req-update-1',
      }),
    ).resolves.toMatchObject({ name: 'Updated project' });
    await expect(
      service.archive({
        currentUser: currentUser('admin'),
        projectId: project.id,
        requestId: 'req-archive-1',
      }),
    ).resolves.toMatchObject({ status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' });
    expect(calls).toEqual([
      'create:admin-id:PRJ-001:req-create-1',
      `update:${project.id}:Updated project:req-update-1`,
      `archive:${project.id}:req-archive-1`,
    ]);
  });

  it('requires projects.members.view before listing current project members', async () => {
    const service = new ProjectsService({ projects: createRepository() });

    await expect(
      service.listMembers({
        currentUser: currentUser('manager'),
        projectId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-members-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['projects.members.view'] },
    } satisfies Partial<ApiError>);
  });

  it('requires projects.members.manage before replacing current project members', async () => {
    const service = new ProjectsService({ projects: createRepository() });

    await expect(
      service.replaceMembers({
        currentUser: currentUser('top_manager'),
        projectId: '11111111-1111-4111-8111-111111111111',
        dto: {
          idempotencyKey: 'members-denied-key',
          members: [{ userId: 7, role: 'manager' }],
          reason: 'staffing',
        },
        requestId: 'req-members-replace-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['projects.members.manage'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates project member read and replace commands with request context', async () => {
    const projectMembers: ProjectMembersResponseDto = {
      projectId: '11111111-1111-4111-8111-111111111111',
      members: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId: 7,
          username: 'member_user',
          employeeId: 11,
          displayName: 'Member User',
          role: 'manager',
          validFrom: '2026-05-27T00:00:00.000Z',
          metadata: {},
        },
      ],
      requestId: 'req-members-view',
    };
    const calls: string[] = [];
    const service = new ProjectsService({
      projects: createRepository({
        async listProjectMembers(command) {
          calls.push(`listMembers:${command.projectId}:${command.requestId}`);
          return projectMembers;
        },
        async replaceProjectMembers(command) {
          calls.push(`replaceMembers:${command.projectId}:${command.dto.members[0]?.userId}:${command.requestId}`);
          return { ...projectMembers, changed: true, auditId: 'audit-1', requestId: command.requestId ?? 'fallback' };
        },
      }),
    });

    await expect(
      service.listMembers({
        currentUser: currentUser('top_manager'),
        projectId: projectMembers.projectId,
        requestId: 'req-members-view',
      }),
    ).resolves.toEqual(projectMembers);
    await expect(
      service.replaceMembers({
        currentUser: currentUser('admin'),
        projectId: projectMembers.projectId,
        dto: {
          idempotencyKey: 'members-key-1',
          members: [{ userId: 7, role: 'manager' }],
          reason: 'staffing',
        },
        requestId: 'req-members-replace',
      }),
    ).resolves.toMatchObject({ changed: true, auditId: 'audit-1' });
    expect(calls).toEqual([
      `listMembers:${projectMembers.projectId}:req-members-view`,
      `replaceMembers:${projectMembers.projectId}:7:req-members-replace`,
    ]);
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
    async createProject() {
      throw new Error('createProject should not be called');
    },
    async updateProject() {
      throw new Error('updateProject should not be called');
    },
    async archiveProject() {
      throw new Error('archiveProject should not be called');
    },
    async listProjectMembers() {
      throw new Error('listProjectMembers should not be called');
    },
    async replaceProjectMembers() {
      throw new Error('replaceProjectMembers should not be called');
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

function createProjectDto(): CreateProjectRequestDto {
  return {
    code: 'PRJ-001',
    name: 'Project',
    status: 'active',
  };
}
