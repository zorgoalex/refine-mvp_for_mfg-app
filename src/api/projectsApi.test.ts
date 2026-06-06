import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsApi, validateProjectId } from './projectsApi';
import type { ProjectDto, ProjectOverviewResponse } from './types/projectApi.types';

describe('projectsApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists and looks up projects with backend query params', async () => {
    const fetchMock = mockFetch(
      { data: [], pagination: { page: 2, pageSize: 20, total: 0, totalPages: 1 } },
      { data: [] },
    );

    await projectsApi.listProjects({
      page: 2,
      pageSize: 20,
      search: 'kitchen',
      status: 'active',
      ownerUserId: 7,
      includeArchived: true,
    });
    await projectsApi.lookupProjects({ search: 'kit', limit: 5 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/projects?page=2&pageSize=20&search=kitchen&status=active&ownerUserId=7&includeArchived=true',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/projects/lookup?search=kit&limit=5');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('GET');
  });

  it('gets, creates, updates, and archives projects through v1 endpoints', async () => {
    const project = projectDto();
    const fetchMock = mockFetch(
      { project },
      { project },
      { project: { ...project, name: 'Updated project' } },
      { project: { ...project, status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' } },
    );

    await expect(projectsApi.getProject(project.id)).resolves.toEqual(project);
    await projectsApi.createProject({ code: 'PRJ-001', name: 'Project' });
    await projectsApi.updateProject(project.id, { name: 'Updated project' });
    await projectsApi.archiveProject(project.id);

    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/projects/${project.id}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/projects');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ code: 'PRJ-001', name: 'Project' }));
    expect(fetchMock.mock.calls[2][0]).toBe(`/api/v1/projects/${project.id}`);
    expect(fetchMock.mock.calls[2][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/v1/projects/${project.id}`);
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
  });

  it('gets project overview with backend query params', async () => {
    const project = projectOverviewProjectDto();
    const overviewResponse: ProjectOverviewResponse = {
      project,
      orders: {
        totalCount: 0,
        statusCounts: [],
        relationCounts: [],
        createdMonthCounts: [],
      },
      linkedEntityCounts: [],
      participants: { currentSummary: [] },
      filter: {
        projectId: project.id,
        temporalMode: 'current',
        createdFrom: '2026-01-01T00:00:00Z',
      },
      omitted: [],
    };
    const fetchMock = mockFetch(overviewResponse, overviewResponse, overviewResponse);

    await projectsApi.getProjectOverview(project.id, {
      temporalMode: 'current',
      createdFrom: '2026-01-01T00:00:00Z',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/projects/11111111-1111-4111-8111-111111111111/overview?temporalMode=current&createdFrom=2026-01-01T00%3A00%3A00Z',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');

    await projectsApi.getProjectOverview(project.id, {
      temporalMode: 'asOf',
      asOf: '2026-02-01T12:30:00Z',
    });

    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/v1/projects/11111111-1111-4111-8111-111111111111/overview?temporalMode=asOf&asOf=2026-02-01T12%3A30%3A00Z',
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe('GET');

    await projectsApi.getProjectOverview(project.id, {
      temporalMode: 'overlap',
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-31T23:59:59Z',
    });

    expect(fetchMock.mock.calls[2][0]).toBe(
      '/api/v1/projects/11111111-1111-4111-8111-111111111111/overview?temporalMode=overlap&from=2026-03-01T00%3A00%3A00Z&to=2026-03-31T23%3A59%3A59Z',
    );
    expect(fetchMock.mock.calls[2][1]?.method).toBe('GET');
    expect(Object.prototype.hasOwnProperty.call(overviewResponse.project, 'metadata')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(overviewResponse.project, 'createdBy')).toBe(false);
  });

  it('rejects invalid project ids before fetch', async () => {
    const fetchMock = mockFetch({ project: projectDto() });

    expect(() => validateProjectId('not-a-uuid')).toThrow('Invalid projectId');
    await expect(projectsApi.getProject('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      'Invalid projectId',
    );
    expect(() =>
      projectsApi.getProjectOverview('11111111-1111-1111-1111-111111111111'),
    ).toThrow('Invalid projectId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gets and replaces order project links through order-scoped v1 endpoints', async () => {
    const fetchMock = mockFetch(
      { orderId: 15, version: 3, primaryProject: null, projects: [], requestId: 'request-1' },
      { orderId: 15, version: 4, primaryProject: null, projects: [], requestId: 'request-2', changed: true },
    );

    await projectsApi.getOrderProjects(15);
    await projectsApi.replaceOrderProjects(15, {
      idempotencyKey: 'order-projects-key-1',
      version: 3,
      primaryProjectId: null,
      projects: [],
      reason: 'test',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/projects');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15/projects');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({
      idempotencyKey: 'order-projects-key-1',
      version: 3,
      primaryProjectId: null,
      projects: [],
      reason: 'test',
    }));
  });

  it('manages project entity links and participants through project-scoped endpoints', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = mockFetch(
      { projectId, links: [], requestId: 'req-links-list' },
      { projectId, links: [], requestId: 'req-links-put', changed: true },
      { projectId, links: [], requestId: 'req-links-post', changed: true },
      { projectId, mode: 'write', summary: { proposed: 1, created: 1, existing: 0, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 }, proposals: [], created: [], existing: [], skipped: [], sampleEvidence: [], writeEnabled: true },
      { projectId, participants: [], requestId: 'req-participants-list' },
      { projectId, participants: [], requestId: 'req-participants-put', changed: true },
      { roles: [{ code: 'observer', label: 'Observer' }], requestId: 'req-roles' },
    );

    await projectsApi.getProjectEntityLinks(projectId);
    await projectsApi.replaceProjectEntityLinks(projectId, {
      idempotencyKey: 'links-replace-key',
      links: [{ entityType: 'order', entityId: '11195', relationType: 'related' }],
      reason: 'frontend test',
    });
    await projectsApi.appendProjectEntityLinks(projectId, {
      idempotencyKey: 'links-append-key',
      links: [{ entityType: 'client', entityId: '22', relationType: 'related' }],
    });
    await projectsApi.batchLinkProjectEntities(projectId, {
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      fixtureKey: 'projects-batch-link-write-2026-06-06',
      idempotencyKey: 'batch-link-write-key',
      entityType: 'order',
      relationType: 'related',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
    });
    await projectsApi.getProjectParticipants(projectId);
    await projectsApi.replaceProjectParticipants(projectId, {
      idempotencyKey: 'participants-replace-key',
      participants: [{ participantType: 'user', participantId: '158', roleCode: 'manager' }],
    });
    await projectsApi.getProjectParticipantRoles();

    expect(fetchMock.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      [`/api/v1/projects/${projectId}/entity-links`, 'GET'],
      [`/api/v1/projects/${projectId}/entity-links`, 'PUT'],
      [`/api/v1/projects/${projectId}/entity-links`, 'POST'],
      [`/api/v1/projects/${projectId}/batch-link`, 'POST'],
      [`/api/v1/projects/${projectId}/participants`, 'GET'],
      [`/api/v1/projects/${projectId}/participants`, 'PUT'],
      ['/api/v1/projects/participant-roles', 'GET'],
    ]);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({
      idempotencyKey: 'links-replace-key',
      links: [{ entityType: 'order', entityId: '11195', relationType: 'related', metadata: {} }],
      reason: 'frontend test',
    }));
    expect(fetchMock.mock.calls[3][1]?.body).toBe(JSON.stringify({
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      fixtureKey: 'projects-batch-link-write-2026-06-06',
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

  it('gets project deadline status counts through narrow report endpoint', async () => {
    const fetchMock = mockFetch({
      data: [{ deadlineStatus: 'overdue', deadlineCount: 2 }],
      filter: {
        projectMode: 'any',
        projectIds: ['11111111-1111-4111-8111-111111111111'],
        temporalMode: 'current',
      },
    });

    await projectsApi.getProjectDeadlineStatusCounts({
      projectMode: 'any',
      projectIds: ['11111111-1111-4111-8111-111111111111'],
      temporalMode: 'current',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/projects/reports/deadline-status-counts?projectMode=any&projectIds=11111111-1111-4111-8111-111111111111&temporalMode=current',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('rejects invalid or empty deadline report project ids before fetch', async () => {
    const fetchMock = mockFetch({ data: [], filter: { projectMode: 'none', temporalMode: 'current' } });

    expect(() =>
      projectsApi.getProjectDeadlineStatusCounts({
        projectMode: 'any',
        projectIds: ['11111111-1111-1111-1111-111111111111'],
        temporalMode: 'current',
      }),
    ).toThrow('Invalid projectId');
    expect(() =>
      projectsApi.getProjectDeadlineStatusCounts({
        projectMode: 'all',
        projectIds: [],
        temporalMode: 'current',
      }),
    ).toThrow('projectIds are required');
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

function projectDto(overrides: Partial<ProjectDto> = {}): ProjectDto {
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
    ...overrides,
  };
}

function projectOverviewProjectDto(
  overrides: Partial<ProjectOverviewResponse['project']> = {},
): ProjectOverviewResponse['project'] {
  const project = projectDto();

  return {
    id: project.id,
    code: project.code,
    name: project.name,
    description: project.description,
    status: project.status,
    startsAt: project.startsAt,
    endsAt: project.endsAt,
    ownerUserId: project.ownerUserId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
    ...overrides,
  };
}
