import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import type { GroupDto, GroupListResponseDto } from './dto/group.dto';
import {
  parseCreateGroupRequest,
  parseReplaceGroupMembersRequest,
  parseGroupId,
  parseGroupListQuery,
  parseGroupLookupQuery,
  parseUpdateGroupRequest,
  GroupsController,
} from './groups.controller';
import type { GroupsRuntimeConfigService } from './groups-runtime-config.service';
import type { GroupsService } from './groups.service';

describe('GroupsController', () => {
  it('fails closed when groups API is disabled by default', async () => {
    const controller = createController({ flags: { groupsEnabled: false, groupsReadOnly: true } });

    await expect(controller.list({ user: currentUser('manager') }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before service calls', async () => {
    const controller = createController({ flags: { groupsEnabled: true, groupsReadOnly: true } });

    await expect(controller.lookup({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('fails write endpoints closed when groups are disabled or read-only', async () => {
    await expect(
      createController({ flags: { groupsEnabled: false, groupsReadOnly: false } }).create(
        { user: currentUser('admin'), requestId: 'req-disabled' },
        { code: 'PRJ-001', name: 'Group' },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups' },
    } satisfies Partial<ApiError>);

    await expect(
      createController({ flags: { groupsEnabled: true, groupsReadOnly: true } }).update(
        { user: currentUser('admin'), requestId: 'req-read-only' },
        '11111111-1111-4111-8111-111111111111',
        { name: 'Updated' },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups', readOnly: true },
    } satisfies Partial<ApiError>);
  });

  it('normalizes list, lookup, and get requests', async () => {
    const group = groupDto();
    const listResponse: GroupListResponseDto = {
      data: [group],
      pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 },
    };
    const calls: string[] = [];
    const controller = createController({
      flags: { groupsEnabled: true, groupsReadOnly: true },
      service: {
        async list(command) {
          calls.push(`list:${command.query.page}:${command.query.status}:${command.query.ownerUserId}`);
          return listResponse;
        },
        async lookup(command) {
          calls.push(`lookup:${command.query.search}:${command.query.limit}`);
          return { data: [{ id: group.id, code: group.code, name: group.name, status: group.status }] };
        },
        async getById(command) {
          calls.push(`get:${command.groupId}`);
          return group;
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
    ).resolves.toEqual({ data: [{ id: group.id, code: group.code, name: group.name, status: group.status }] });
    await expect(controller.getById({ user: currentUser('admin') }, group.id)).resolves.toEqual({
      group,
    });
    expect(calls).toEqual([`list:2:active:7`, 'lookup:kitchen:5', `get:${group.id}`]);
  });

  it('normalizes create, update, and archive requests with request id metadata', async () => {
    const group = groupDto();
    const calls: string[] = [];
    const controller = createController({
      flags: { groupsEnabled: true, groupsReadOnly: false },
      service: {
        async create(command) {
          calls.push(`create:${command.currentUser.id}:${command.dto.code}:${command.dto.startsAt}:${command.requestId}`);
          return group;
        },
        async update(command) {
          calls.push(`update:${command.groupId}:${command.dto.name}:${command.dto.endsAt}:${command.requestId}`);
          return { ...group, name: command.dto.name ?? group.name };
        },
        async archive(command) {
          calls.push(`archive:${command.groupId}:${command.requestId}`);
          return { ...group, status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' };
        },
      },
    });

    await expect(
      controller.create(
        { user: currentUser('admin'), requestId: 'req-create-1' },
        {
          code: ' PRJ-001 ',
          name: ' Group ',
          description: ' Notes ',
          status: 'draft',
          startsAt: '2026-05-01',
          endsAt: '2026-05-02',
          ownerUserId: 7,
          metadata: { source: 'test' },
        },
      ),
    ).resolves.toEqual({ group });
    await expect(
      controller.update(
        { user: currentUser('admin'), requestId: 'req-update-1' },
        group.id,
        { name: ' Updated ', endsAt: '2026-05-04' },
      ),
    ).resolves.toEqual({ group: { ...group, name: 'Updated' } });
    await expect(
      controller.archive(
        { user: currentUser('admin'), requestId: 'req-archive-1' },
        group.id,
      ),
    ).resolves.toMatchObject({ group: { status: 'archived' } });
    expect(calls).toEqual([
      'create:admin-id:PRJ-001:2026-05-01:req-create-1',
      `update:${group.id}:Updated:2026-05-04:req-update-1`,
      `archive:${group.id}:req-archive-1`,
    ]);
  });

  it('normalizes group member GET and PUT requests with request id metadata', async () => {
    const calls: string[] = [];
    const response = {
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
      requestId: 'req-members-get',
    };
    const controller = createController({
      flags: { groupsEnabled: true, groupsReadOnly: false },
      service: {
        async listMembers(command) {
          calls.push(`listMembers:${command.groupId}:${command.requestId}`);
          return response;
        },
        async replaceMembers(command) {
          calls.push(`replaceMembers:${command.groupId}:${command.dto.members[0]?.userId}:${command.dto.reason}:${command.requestId}`);
          return { ...response, changed: true, auditId: 'audit-1', requestId: command.requestId ?? 'fallback' };
        },
      },
    });

    await expect(
      controller.listMembers(
        { user: currentUser('top_manager'), requestId: 'req-members-get' },
        response.groupId,
      ),
    ).resolves.toEqual(response);
    await expect(
      controller.replaceMembers(
        { user: currentUser('admin'), requestId: 'req-members-put' },
        response.groupId,
        {
          idempotencyKey: ' member-key-1 ',
          members: [{ userId: 7, role: ' manager ', metadata: { allocation: 'lead' } }],
          reason: ' staffing ',
        },
      ),
    ).resolves.toMatchObject({ changed: true, auditId: 'audit-1' });
    expect(calls).toEqual([
      `listMembers:${response.groupId}:req-members-get`,
      `replaceMembers:${response.groupId}:7:staffing:req-members-put`,
    ]);
  });

  it('fails group member writes closed when groups are disabled or read-only', async () => {
    await expect(
      createController({ flags: { groupsEnabled: false, groupsReadOnly: false } }).listMembers(
        { user: currentUser('top_manager'), requestId: 'req-disabled' },
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups' },
    } satisfies Partial<ApiError>);

    await expect(
      createController({ flags: { groupsEnabled: true, groupsReadOnly: true } }).replaceMembers(
        { user: currentUser('admin'), requestId: 'req-read-only' },
        '11111111-1111-4111-8111-111111111111',
        { idempotencyKey: 'members-read-only', members: [] },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'groups', readOnly: true },
    } satisfies Partial<ApiError>);
  });

  it('validates group query values and UUID path params', () => {
    expect(parseGroupId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => parseGroupId('not-a-uuid')).toThrow(ApiError);
    expect(() => parseGroupListQuery({ status: 'unknown' })).toThrow(ApiError);
    expect(() => parseGroupListQuery({ ownerUserId: '0' })).toThrow(ApiError);
    expect(() => parseGroupLookupQuery({ limit: '101' })).toThrow(ApiError);
  });

  it('validates create and update bodies against group table constraints', () => {
    expect(parseCreateGroupRequest({ code: 'PRJ-001', name: ' Group ' })).toMatchObject({
      code: 'PRJ-001',
      name: 'Group',
      status: 'active',
    });
    expect(parseUpdateGroupRequest({ description: null })).toEqual({ description: null });
    expect(() => parseCreateGroupRequest({ code: 'x', name: 'Group' })).toThrow(ApiError);
    expect(() => parseCreateGroupRequest({ code: 'BAD CODE', name: 'Group' })).toThrow(ApiError);
    expect(() => parseCreateGroupRequest({ code: 'PRJ-001', name: ' ' })).toThrow(ApiError);
    expect(() =>
      parseCreateGroupRequest({ code: 'PRJ-001', name: 'Group', startsAt: '2026-05-03', endsAt: '2026-05-02' }),
    ).toThrow(ApiError);
    expect(() =>
      parseCreateGroupRequest({ code: 'PRJ-001', name: 'Group', startsAt: '2026-99-99' }),
    ).toThrow(ApiError);
    expect(() =>
      parseUpdateGroupRequest({ endsAt: '2026-02-31' }),
    ).toThrow(ApiError);
    expect(() => parseCreateGroupRequest({ code: 'PRJ-001', name: 'Group', status: 'archived' })).toThrow(ApiError);
    expect(() => parseUpdateGroupRequest({})).toThrow(ApiError);
    expect(() => parseUpdateGroupRequest({ status: 'unknown' })).toThrow(ApiError);
    expect(() => parseUpdateGroupRequest({ status: 'archived' })).toThrow(ApiError);
  });

  it('validates group member replace bodies against temporal member table constraints', () => {
    expect(parseReplaceGroupMembersRequest({
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

    expect(() => parseReplaceGroupMembersRequest({ idempotencyKey: '', members: [] })).toThrow(ApiError);
    expect(() => parseReplaceGroupMembersRequest({ idempotencyKey: 'members', members: [{ userId: 0, role: 'manager' }] })).toThrow(ApiError);
    expect(() => parseReplaceGroupMembersRequest({ idempotencyKey: 'members', members: [{ userId: 7, role: '' }] })).toThrow(ApiError);
    expect(() => parseReplaceGroupMembersRequest({
      idempotencyKey: 'members',
      members: [
        { userId: 7, role: 'manager' },
        { userId: 7, role: 'manager' },
      ],
    })).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { groupsEnabled: boolean; groupsReadOnly: boolean };
  service?: Partial<GroupsService>;
}): GroupsController {
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
  } as unknown as GroupsService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as GroupsRuntimeConfigService;

  return new GroupsController(service, runtimeConfig);
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
