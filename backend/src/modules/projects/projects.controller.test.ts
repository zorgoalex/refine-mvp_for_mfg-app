import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import type { ProjectDto, ProjectListResponseDto } from './dto/project.dto';
import {
  parseCreateProjectRequest,
  parseReplaceProjectMembersRequest,
  parseProjectId,
  parseProjectListQuery,
  parseProjectLookupQuery,
  parseUpdateProjectRequest,
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

  it('fails write endpoints closed when projects are disabled or read-only', async () => {
    await expect(
      createController({ flags: { projectsEnabled: false, projectsReadOnly: false } }).create(
        { user: currentUser('admin'), requestId: 'req-disabled' },
        { code: 'PRJ-001', name: 'Project' },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects' },
    } satisfies Partial<ApiError>);

    await expect(
      createController({ flags: { projectsEnabled: true, projectsReadOnly: true } }).update(
        { user: currentUser('admin'), requestId: 'req-read-only' },
        '11111111-1111-4111-8111-111111111111',
        { name: 'Updated' },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects', readOnly: true },
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

  it('normalizes create, update, and archive requests with request id metadata', async () => {
    const project = projectDto();
    const calls: string[] = [];
    const controller = createController({
      flags: { projectsEnabled: true, projectsReadOnly: false },
      service: {
        async create(command) {
          calls.push(`create:${command.currentUser.id}:${command.dto.code}:${command.dto.startsAt}:${command.requestId}`);
          return project;
        },
        async update(command) {
          calls.push(`update:${command.projectId}:${command.dto.name}:${command.dto.endsAt}:${command.requestId}`);
          return { ...project, name: command.dto.name ?? project.name };
        },
        async archive(command) {
          calls.push(`archive:${command.projectId}:${command.requestId}`);
          return { ...project, status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' };
        },
      },
    });

    await expect(
      controller.create(
        { user: currentUser('admin'), requestId: 'req-create-1' },
        {
          code: ' PRJ-001 ',
          name: ' Project ',
          description: ' Notes ',
          status: 'draft',
          startsAt: '2026-05-01',
          endsAt: '2026-05-02',
          ownerUserId: 7,
          metadata: { source: 'test' },
        },
      ),
    ).resolves.toEqual({ project });
    await expect(
      controller.update(
        { user: currentUser('admin'), requestId: 'req-update-1' },
        project.id,
        { name: ' Updated ', endsAt: '2026-05-04' },
      ),
    ).resolves.toEqual({ project: { ...project, name: 'Updated' } });
    await expect(
      controller.archive(
        { user: currentUser('admin'), requestId: 'req-archive-1' },
        project.id,
      ),
    ).resolves.toMatchObject({ project: { status: 'archived' } });
    expect(calls).toEqual([
      'create:admin-id:PRJ-001:2026-05-01:req-create-1',
      `update:${project.id}:Updated:2026-05-04:req-update-1`,
      `archive:${project.id}:req-archive-1`,
    ]);
  });

  it('normalizes project member GET and PUT requests with request id metadata', async () => {
    const calls: string[] = [];
    const response = {
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
      requestId: 'req-members-get',
    };
    const controller = createController({
      flags: { projectsEnabled: true, projectsReadOnly: false },
      service: {
        async listMembers(command) {
          calls.push(`listMembers:${command.projectId}:${command.requestId}`);
          return response;
        },
        async replaceMembers(command) {
          calls.push(`replaceMembers:${command.projectId}:${command.dto.members[0]?.userId}:${command.dto.reason}:${command.requestId}`);
          return { ...response, changed: true, auditId: 'audit-1', requestId: command.requestId ?? 'fallback' };
        },
      },
    });

    await expect(
      controller.listMembers(
        { user: currentUser('top_manager'), requestId: 'req-members-get' },
        response.projectId,
      ),
    ).resolves.toEqual(response);
    await expect(
      controller.replaceMembers(
        { user: currentUser('admin'), requestId: 'req-members-put' },
        response.projectId,
        {
          idempotencyKey: ' member-key-1 ',
          members: [{ userId: 7, role: ' manager ', metadata: { allocation: 'lead' } }],
          reason: ' staffing ',
        },
      ),
    ).resolves.toMatchObject({ changed: true, auditId: 'audit-1' });
    expect(calls).toEqual([
      `listMembers:${response.projectId}:req-members-get`,
      `replaceMembers:${response.projectId}:7:staffing:req-members-put`,
    ]);
  });

  it('fails project member writes closed when projects are disabled or read-only', async () => {
    await expect(
      createController({ flags: { projectsEnabled: false, projectsReadOnly: false } }).listMembers(
        { user: currentUser('top_manager'), requestId: 'req-disabled' },
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects' },
    } satisfies Partial<ApiError>);

    await expect(
      createController({ flags: { projectsEnabled: true, projectsReadOnly: true } }).replaceMembers(
        { user: currentUser('admin'), requestId: 'req-read-only' },
        '11111111-1111-4111-8111-111111111111',
        { idempotencyKey: 'members-read-only', members: [] },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'projects', readOnly: true },
    } satisfies Partial<ApiError>);
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

  it('validates create and update bodies against project table constraints', () => {
    expect(parseCreateProjectRequest({ code: 'PRJ-001', name: ' Project ' })).toMatchObject({
      code: 'PRJ-001',
      name: 'Project',
      status: 'active',
    });
    expect(parseUpdateProjectRequest({ description: null })).toEqual({ description: null });
    expect(() => parseCreateProjectRequest({ code: 'x', name: 'Project' })).toThrow(ApiError);
    expect(() => parseCreateProjectRequest({ code: 'BAD CODE', name: 'Project' })).toThrow(ApiError);
    expect(() => parseCreateProjectRequest({ code: 'PRJ-001', name: ' ' })).toThrow(ApiError);
    expect(() =>
      parseCreateProjectRequest({ code: 'PRJ-001', name: 'Project', startsAt: '2026-05-03', endsAt: '2026-05-02' }),
    ).toThrow(ApiError);
    expect(() =>
      parseCreateProjectRequest({ code: 'PRJ-001', name: 'Project', startsAt: '2026-99-99' }),
    ).toThrow(ApiError);
    expect(() =>
      parseUpdateProjectRequest({ endsAt: '2026-02-31' }),
    ).toThrow(ApiError);
    expect(() => parseCreateProjectRequest({ code: 'PRJ-001', name: 'Project', status: 'archived' })).toThrow(ApiError);
    expect(() => parseUpdateProjectRequest({})).toThrow(ApiError);
    expect(() => parseUpdateProjectRequest({ status: 'unknown' })).toThrow(ApiError);
    expect(() => parseUpdateProjectRequest({ status: 'archived' })).toThrow(ApiError);
  });

  it('validates project member replace bodies against temporal member table constraints', () => {
    expect(parseReplaceProjectMembersRequest({
      idempotencyKey: ' members-key ',
      members: [
        { userId: 7, role: ' manager ', metadata: { allocation: 'lead' } },
        { userId: 8, role: 'observer' },
      ],
      reason: ' staffing ',
    })).toEqual({
      idempotencyKey: 'members-key',
      members: [
        { userId: 7, role: 'manager', metadata: { allocation: 'lead' } },
        { userId: 8, role: 'observer' },
      ],
      reason: 'staffing',
    });

    expect(() => parseReplaceProjectMembersRequest({ idempotencyKey: '', members: [] })).toThrow(ApiError);
    expect(() => parseReplaceProjectMembersRequest({ idempotencyKey: 'members', members: [{ userId: 0, role: 'manager' }] })).toThrow(ApiError);
    expect(() => parseReplaceProjectMembersRequest({ idempotencyKey: 'members', members: [{ userId: 7, role: '' }] })).toThrow(ApiError);
    expect(() => parseReplaceProjectMembersRequest({
      idempotencyKey: 'members',
      members: [
        { userId: 7, role: 'manager' },
        { userId: 7, role: 'manager' },
      ],
    })).toThrow(ApiError);
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
    async create() {
      throw new Error('create should not be called');
    },
    async update() {
      throw new Error('update should not be called');
    },
    async archive() {
      throw new Error('archive should not be called');
    },
    async listMembers() {
      throw new Error('listMembers should not be called');
    },
    async replaceMembers() {
      throw new Error('replaceMembers should not be called');
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
