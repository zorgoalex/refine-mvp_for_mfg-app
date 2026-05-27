import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsApi, validateProjectId } from './projectsApi';
import type { ProjectDto } from './types/projectApi.types';

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

  it('rejects invalid project ids before fetch', async () => {
    const fetchMock = mockFetch({ project: projectDto() });

    expect(() => validateProjectId('not-a-uuid')).toThrow('Invalid projectId');
    await expect(projectsApi.getProject('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      'Invalid projectId',
    );
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
