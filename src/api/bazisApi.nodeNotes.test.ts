import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bazisApi } from './bazisApi';
import { httpClient } from './httpClient';

vi.mock('./httpClient', () => ({
  httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(httpClient.patch).mockReset();
});

describe('bazisApi.setNodeNotes', () => {
  it('PATCHes node notes route with body', async () => {
    vi.mocked(httpClient.patch).mockResolvedValue({ bazisNodeId: 7213, notes: 'текст' });

    const result = await bazisApi.setNodeNotes(7213, 'текст');

    expect(httpClient.patch).toHaveBeenCalledWith(
      expect.stringContaining('/bazis/nodes/7213/notes'),
      { notes: 'текст' },
    );
    expect(result).toEqual({ bazisNodeId: 7213, notes: 'текст' });
  });

  it('passes null to clear notes', async () => {
    vi.mocked(httpClient.patch).mockResolvedValue({ bazisNodeId: 7213, notes: null });

    await bazisApi.setNodeNotes(7213, null);

    expect(httpClient.patch).toHaveBeenCalledWith(expect.any(String), { notes: null });
  });

  it('rejects invalid node id', async () => {
    expect(() => bazisApi.setNodeNotes(Number.NaN, 'x')).toThrowError();
  });
});
