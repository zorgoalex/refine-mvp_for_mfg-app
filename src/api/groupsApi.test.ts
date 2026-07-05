import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupsApi, validateGroupId } from './groupsApi';
import type { GroupDto, GroupOverviewResponse } from './types/groupApi.types';

describe('groupsApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists and looks up groups with backend query params', async () => {
    const fetchMock = mockFetch(
      { data: [], pagination: { page: 2, pageSize: 20, total: 0, totalPages: 1 } },
      { data: [] },
    );

    await groupsApi.listGroups({
      page: 2,
      pageSize: 20,
      search: 'kitchen',
      status: 'active',
      ownerUserId: 7,
      includeArchived: true,
    });
    await groupsApi.lookupGroups({ search: 'kit', limit: 5 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/groups?page=2&pageSize=20&search=kitchen&status=active&ownerUserId=7&includeArchived=true',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/lookup?search=kit&limit=5');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('GET');
  });

  it('maps group options through the backend groups list endpoint', async () => {
    const group = groupDto({ code: 'GRP-101', name: 'Kitchen' });
    const fetchMock = mockFetch({
      data: [group],
      pagination: { page: 1, pageSize: 200, total: 1, totalPages: 1 },
    });

    await expect(groupsApi.listGroupOptions({ search: 'kit' })).resolves.toEqual([
      { value: group.id, label: 'GRP-101 · Kitchen' },
    ]);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups?pageSize=200&search=kit');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('gets, creates, updates, and archives groups through v1 endpoints', async () => {
    const group = groupDto();
    const fetchMock = mockFetch(
      { group },
      { group },
      { group: { ...group, name: 'Updated group' } },
      { group: { ...group, status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' } },
    );

    await expect(groupsApi.getGroup(group.id)).resolves.toEqual(group);
    await groupsApi.createGroup({ code: 'GRP-001', name: 'Group' });
    await groupsApi.updateGroup(group.id, { name: 'Updated group' });
    await groupsApi.archiveGroup(group.id);

    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/groups/${group.id}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ code: 'GRP-001', name: 'Group' }));
    expect(fetchMock.mock.calls[2][0]).toBe(`/api/v1/groups/${group.id}`);
    expect(fetchMock.mock.calls[2][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/v1/groups/${group.id}`);
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
  });

  it('gets group overview with backend query params', async () => {
    const group = groupOverviewGroupDto();
    const overviewResponse: GroupOverviewResponse = {
      group,
      orders: {
        totalCount: 0,
        statusCounts: [],
        relationCounts: [],
        createdMonthCounts: [],
      },
      linkedEntityCounts: [],
      participants: { currentSummary: [] },
      filter: {
        groupId: group.id,
        temporalMode: 'current',
        createdFrom: '2026-01-01T00:00:00Z',
      },
      omitted: [],
    };
    const fetchMock = mockFetch(overviewResponse, overviewResponse, overviewResponse);

    await groupsApi.getGroupOverview(group.id, {
      temporalMode: 'current',
      createdFrom: '2026-01-01T00:00:00Z',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/groups/11111111-1111-4111-8111-111111111111/overview?temporalMode=current&createdFrom=2026-01-01T00%3A00%3A00Z',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');

    await groupsApi.getGroupOverview(group.id, {
      temporalMode: 'asOf',
      asOf: '2026-02-01T12:30:00Z',
    });

    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/v1/groups/11111111-1111-4111-8111-111111111111/overview?temporalMode=asOf&asOf=2026-02-01T12%3A30%3A00Z',
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe('GET');

    await groupsApi.getGroupOverview(group.id, {
      temporalMode: 'overlap',
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-31T23:59:59Z',
    });

    expect(fetchMock.mock.calls[2][0]).toBe(
      '/api/v1/groups/11111111-1111-4111-8111-111111111111/overview?temporalMode=overlap&from=2026-03-01T00%3A00%3A00Z&to=2026-03-31T23%3A59%3A59Z',
    );
    expect(fetchMock.mock.calls[2][1]?.method).toBe('GET');
    expect(Object.prototype.hasOwnProperty.call(overviewResponse.group, 'metadata')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(overviewResponse.group, 'createdBy')).toBe(false);
  });

  it('rejects invalid group ids before fetch', async () => {
    const fetchMock = mockFetch({ group: groupDto() });

    expect(() => validateGroupId('not-a-uuid')).toThrow('Invalid groupId');
    await expect(groupsApi.getGroup('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      'Invalid groupId',
    );
    expect(() =>
      groupsApi.getGroupOverview('11111111-1111-1111-1111-111111111111'),
    ).toThrow('Invalid groupId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gets and replaces order group links through order-scoped v1 endpoints', async () => {
    const fetchMock = mockFetch(
      { orderId: 15, version: 3, primaryGroup: null, groups: [], requestId: 'request-1' },
      { orderId: 15, version: 4, primaryGroup: null, groups: [], requestId: 'request-2', changed: true },
    );

    await groupsApi.getOrderGroups(15);
    await groupsApi.replaceOrderGroups(15, {
      idempotencyKey: 'order-groups-key-1',
      version: 3,
      primaryGroupId: null,
      groups: [],
      reason: 'test',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/groups');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15/groups');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({
      idempotencyKey: 'order-groups-key-1',
      version: 3,
      primaryGroupId: null,
      groups: [],
      reason: 'test',
    }));
  });

  it('manages group entity links and participants through group-scoped endpoints', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = mockFetch(
      { groupId, links: [], requestId: 'req-links-list' },
      { groupId, links: [], requestId: 'req-links-put', changed: true },
      { groupId, links: [], requestId: 'req-links-post', changed: true },
      { groupId, mode: 'write', summary: { proposed: 1, created: 1, existing: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 }, proposals: [], created: [], existing: [], skipped: [], sampleEvidence: [], writeEnabled: true },
      { groupId, participants: [], requestId: 'req-participants-list' },
      { groupId, participants: [], requestId: 'req-participants-put', changed: true },
      { roles: [{ code: 'observer', label: 'Observer' }], requestId: 'req-roles' },
    );

    await groupsApi.getGroupEntityLinks(groupId);
    await groupsApi.replaceGroupEntityLinks(groupId, {
      idempotencyKey: 'links-replace-key',
      links: [{ entityType: 'order', entityId: '11195', relationType: 'related' }],
      reason: 'frontend test',
    });
    await groupsApi.appendGroupEntityLinks(groupId, {
      idempotencyKey: 'links-append-key',
      links: [{ entityType: 'client', entityId: '22', relationType: 'related' }],
    });
    await groupsApi.batchLinkGroupEntities(groupId, {
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      fixtureKey: 'groups-batch-link-write-2026-06-06',
      idempotencyKey: 'batch-link-write-key',
      entityType: 'order',
      relationType: 'related',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
    });
    await groupsApi.getGroupParticipants(groupId);
    await groupsApi.replaceGroupParticipants(groupId, {
      idempotencyKey: 'participants-replace-key',
      participants: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    });
    await groupsApi.getGroupParticipantRoles();

    expect(fetchMock.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      [`/api/v1/groups/${groupId}/entity-links`, 'GET'],
      [`/api/v1/groups/${groupId}/entity-links`, 'PUT'],
      [`/api/v1/groups/${groupId}/entity-links`, 'POST'],
      [`/api/v1/groups/${groupId}/batch-link`, 'POST'],
      [`/api/v1/groups/${groupId}/participants`, 'GET'],
      [`/api/v1/groups/${groupId}/participants`, 'PUT'],
      ['/api/v1/groups/participant-roles', 'GET'],
    ]);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({
      idempotencyKey: 'links-replace-key',
      links: [{ entityType: 'order', entityId: '11195', relationType: 'related', metadata: {} }],
      reason: 'frontend test',
    }));
    expect(fetchMock.mock.calls[3][1]?.body).toBe(JSON.stringify({
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      fixtureKey: 'groups-batch-link-write-2026-06-06',
      idempotencyKey: 'batch-link-write-key',
      entityType: 'order',
      relationType: 'related',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
    }));
    expect(fetchMock.mock.calls[5][1]?.body).toBe(JSON.stringify({
      idempotencyKey: 'participants-replace-key',
      participants: [{ participantType: 'user', participantId: '158', roleCode: 'manager', metadata: {} }],
    }));
  });

  it('gets group deadline status counts through narrow report endpoint', async () => {
    const fetchMock = mockFetch({
      data: [{ deadlineStatus: 'overdue', deadlineCount: 2 }],
      filter: {
        groupMode: 'any',
        groupIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
      },
    });

    await groupsApi.getGroupDeadlineStatusCounts({
      groupMode: 'any',
      groupIds: ['11111111-1111-4111-8111-111111111111'],
      temporalMode: 'current',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/groups/reports/deadline-status-counts?groupMode=any&groupIds=11111111-1111-4111-8111-111111111111&temporalMode=current',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('rejects invalid or empty deadline report group ids before fetch', async () => {
    const fetchMock = mockFetch({ data: [], filter: { groupMode: 'none', temporalMode: 'current' } });

    expect(() =>
      groupsApi.getGroupDeadlineStatusCounts({
        groupMode: 'any',
        groupIds: ['11111111-1111-1111-1111-111111111111'],
        temporalMode: 'current',
      }),
    ).toThrow('Invalid groupId');
    expect(() =>
      groupsApi.getGroupDeadlineStatusCounts({
        groupMode: 'all',
        groupIds: [],
        temporalMode: 'current',
      }),
    ).toThrow('groupIds are required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function groupDto(overrides: Partial<GroupDto> = {}): GroupDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'GRP-001',
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
    ...overrides,
  };
}

function groupOverviewGroupDto(
  overrides: Partial<GroupOverviewResponse['group']> = {},
): GroupOverviewResponse['group'] {
  const group = groupDto();

  return {
    id: group.id,
    code: group.code,
    name: group.name,
    description: group.description,
    status: group.status,
    startsAt: group.startsAt,
    endsAt: group.endsAt,
    ownerUserId: group.ownerUserId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    archivedAt: group.archivedAt,
    ...overrides,
  };
}
