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

describe('bazisApi.exportCutXls', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('POSTs selected Bazis panel ids and returns the XLS filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([0xd0, 0xcf]), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.ms-excel',
        'Content-Disposition': "attachment; filename*=UTF-8''%D0%91%D0%B0%D0%B7%D0%B8%D1%81.xls",
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await bazisApi.exportCutXls(12, [101, 102]);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/bazis/revisions/12/export-cut.xls');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ selectedNodeIds: [101, 102] }),
    });
    expect(result.fileName).toBe('Базис.xls');
    expect(result.blob.type).toBe('application/vnd.ms-excel');
  });

  it('rejects an empty or oversized selection before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(bazisApi.exportCutXls(12, [])).rejects.toThrow('Invalid selectedNodeIds');
    await expect(bazisApi.exportCutXls(12, Array.from({ length: 501 }, (_, index) => index + 1)))
      .rejects.toThrow('Invalid selectedNodeIds');
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
