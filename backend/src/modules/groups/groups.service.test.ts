import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import type {
  CreateGroupRequestDto,
  GroupMembersResponseDto,
  GroupDto,
  GroupListResponseDto,
  UpdateGroupRequestDto,
} from './dto/group.dto';
import { GroupNotFoundError, GroupsService, type GroupRepositoryPort } from './groups.service';

describe('GroupsService', () => {
  it('requires groups.view before listing groups', async () => {
    const service = new GroupsService({ groups: createRepository() });

    await expect(
      service.list({ currentUser: currentUser('operator'), query: { page: 1, pageSize: 25 } }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['groups.view'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates read methods for users with groups.view', async () => {
    const group = groupDto();
    const listResponse: GroupListResponseDto = {
      data: [group],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    };
    const calls: string[] = [];
    const service = new GroupsService({
      groups: createRepository({
        async listGroups(query) {
          calls.push(`list:${query.page}`);
          return listResponse;
        },
        async lookupGroups(query) {
          calls.push(`lookup:${query.search ?? ''}:${query.limit}`);
          return { data: [{ id: group.id, code: group.code, name: group.name, status: group.status }] };
        },
        async getGroupById(groupId) {
          calls.push(`get:${groupId}`);
          return group;
        },
      }),
    });

    await expect(
      service.list({ currentUser: currentUser('manager'), query: { page: 1, pageSize: 25 } }),
    ).resolves.toEqual(listResponse);
    await expect(
      service.lookup({ currentUser: currentUser('viewer'), query: { search: 'prj', limit: 10 } }),
    ).resolves.toEqual({ data: [{ id: group.id, code: group.code, name: group.name, status: group.status }] });
    await expect(
      service.getById({ currentUser: currentUser('top_manager'), groupId: group.id }),
    ).resolves.toEqual(group);
    expect(calls).toEqual(['list:1', 'lookup:prj:10', `get:${group.id}`]);
  });

  it('maps missing groups to GroupNotFoundError', async () => {
    const service = new GroupsService({ groups: createRepository({ async getGroupById() { return null; } }) });

    await expect(
      service.getById({
        currentUser: currentUser('manager'),
        groupId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('requires group write permissions before delegating create, update, or archive', async () => {
    const service = new GroupsService({ groups: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.create({
        currentUser: viewer,
        dto: createGroupDto(),
        requestId: 'req-create-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['groups.create'] },
    } satisfies Partial<ApiError>);

    await expect(
      service.update({
        currentUser: viewer,
        groupId: '11111111-1111-4111-8111-111111111111',
        dto: { name: 'Updated group' },
        requestId: 'req-update-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['groups.update'] },
    } satisfies Partial<ApiError>);

    await expect(
      service.archive({
        currentUser: viewer,
        groupId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-archive-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['groups.archive'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates write methods for users with group write permissions', async () => {
    const group = groupDto();
    const calls: string[] = [];
    const service = new GroupsService({
      groups: createRepository({
        async createGroup(command) {
          calls.push(`create:${command.currentUser.id}:${command.dto.code}:${command.requestId}`);
          return group;
        },
        async updateGroup(command) {
          calls.push(`update:${command.groupId}:${command.dto.name}:${command.requestId}`);
          return { ...group, name: command.dto.name ?? group.name };
        },
        async archiveGroup(command) {
          calls.push(`archive:${command.groupId}:${command.requestId}`);
          return { ...group, status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' };
        },
      }),
    });

    await expect(
      service.create({
        currentUser: currentUser('admin'),
        dto: createGroupDto(),
        requestId: 'req-create-1',
      }),
    ).resolves.toEqual(group);
    await expect(
      service.update({
        currentUser: currentUser('admin'),
        groupId: group.id,
        dto: { name: 'Updated group' } satisfies UpdateGroupRequestDto,
        requestId: 'req-update-1',
      }),
    ).resolves.toMatchObject({ name: 'Updated group' });
    await expect(
      service.archive({
        currentUser: currentUser('admin'),
        groupId: group.id,
        requestId: 'req-archive-1',
      }),
    ).resolves.toMatchObject({ status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' });
    expect(calls).toEqual([
      'create:admin-id:PRJ-001:req-create-1',
      `update:${group.id}:Updated group:req-update-1`,
      `archive:${group.id}:req-archive-1`,
    ]);
  });

  it('requires groups.members.view before listing current group members', async () => {
    const service = new GroupsService({ groups: createRepository() });

    await expect(
      service.listMembers({
        currentUser: currentUser('manager'),
        groupId: '11111111-1111-4111-8111-111111111111',
        requestId: 'req-members-denied',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['groups.members.view'] },
    } satisfies Partial<ApiError>);
  });

  it('requires groups.members.manage before replacing current group members', async () => {
    const service = new GroupsService({ groups: createRepository() });

    await expect(
      service.replaceMembers({
        currentUser: currentUser('top_manager'),
        groupId: '11111111-1111-4111-8111-111111111111',
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
      details: { requiredPermissions: ['groups.members.manage'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates group member read and replace commands with request context', async () => {
    const groupMembers: GroupMembersResponseDto = {
      groupId: '11111111-1111-4111-8111-111111111111',
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
    const service = new GroupsService({
      groups: createRepository({
        async listGroupMembers(command) {
          calls.push(`listMembers:${command.groupId}:${command.requestId}`);
          return groupMembers;
        },
        async replaceGroupMembers(command) {
          calls.push(`replaceMembers:${command.groupId}:${command.dto.members[0]?.userId}:${command.requestId}`);
          return { ...groupMembers, changed: true, auditId: 'audit-1', requestId: command.requestId ?? 'fallback' };
        },
      }),
    });

    await expect(
      service.listMembers({
        currentUser: currentUser('top_manager'),
        groupId: groupMembers.groupId,
        requestId: 'req-members-view',
      }),
    ).resolves.toEqual(groupMembers);
    await expect(
      service.replaceMembers({
        currentUser: currentUser('admin'),
        groupId: groupMembers.groupId,
        dto: {
          idempotencyKey: 'members-key-1',
          members: [{ userId: 7, role: 'manager' }],
          reason: 'staffing',
        },
        requestId: 'req-members-replace',
      }),
    ).resolves.toMatchObject({ changed: true, auditId: 'audit-1' });
    expect(calls).toEqual([
      `listMembers:${groupMembers.groupId}:req-members-view`,
      `replaceMembers:${groupMembers.groupId}:7:req-members-replace`,
    ]);
  });
});

function createRepository(overrides: Partial<GroupRepositoryPort> = {}): GroupRepositoryPort {
  return {
    async listGroups() {
      throw new Error('listGroups should not be called');
    },
    async lookupGroups() {
      throw new Error('lookupGroups should not be called');
    },
    async getGroupById() {
      throw new Error('getGroupById should not be called');
    },
    async createGroup() {
      throw new Error('createGroup should not be called');
    },
    async updateGroup() {
      throw new Error('updateGroup should not be called');
    },
    async archiveGroup() {
      throw new Error('archiveGroup should not be called');
    },
    async listGroupMembers() {
      throw new Error('listGroupMembers should not be called');
    },
    async replaceGroupMembers() {
      throw new Error('replaceGroupMembers should not be called');
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

function groupDto(): GroupDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'PRJ-001',
    name: 'Group',
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

function createGroupDto(): CreateGroupRequestDto {
  return {
    code: 'PRJ-001',
    name: 'Group',
    status: 'active',
  };
}
