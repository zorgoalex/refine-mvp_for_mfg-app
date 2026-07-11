import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bazisApi } from './bazisApi';

describe('bazisApi.deleteProject', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('DELETEs /api/v1/bazis/projects/:id and returns the summary', async () => {
    const response = {
      bazisProjectId: 13,
      projectId: 4640,
      name: 'санузел + шкаф',
      revisionsDeleted: 1,
      nodesDeleted: 639,
    };
    const fetchMock = mockFetch(response);

    await expect(bazisApi.deleteProject(13)).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/bazis/projects/13');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('rejects an invalid id before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => bazisApi.deleteProject(0)).toThrow('Invalid bazisProjectId');
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
