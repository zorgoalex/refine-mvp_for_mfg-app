import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mdfProductionReturnApi, toMdfReturnBoardWindow } from './mdfProductionReturnApi';
import { httpClient } from './httpClient';

vi.mock('./httpClient', () => ({
  httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(httpClient.post).mockReset();
});

describe('toMdfReturnBoardWindow', () => {
  it('strips extra keys such as days', () => {
    expect(
      toMdfReturnBoardWindow({ dateFrom: '2026-09-19', dateTo: '2026-09-25', days: 7 } as any),
    ).toEqual({ dateFrom: '2026-09-19', dateTo: '2026-09-25' });
  });

  it('passes undefined through unchanged', () => {
    expect(toMdfReturnBoardWindow(undefined)).toBeUndefined();
  });
});

describe('mdfProductionReturnApi', () => {
  it('preview posts a boardWindow without extra keys', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({} as any);

    await mdfProductionReturnApi.preview(
      { kind: 'packet', id: 'p1' },
      {
        targetColumn: 'parsed',
        boardWindow: { dateFrom: '2026-09-19', dateTo: '2026-09-25', days: 7 } as any,
      },
    );

    expect(httpClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/preview'),
      expect.objectContaining({
        boardWindow: { dateFrom: '2026-09-19', dateTo: '2026-09-25' },
      }),
    );
    const [, body] = vi.mocked(httpClient.post).mock.calls[0];
    expect(body).not.toHaveProperty('boardWindow.days');
    expect(Object.keys((body as any).boardWindow)).toEqual(['dateFrom', 'dateTo']);
  });

  it('confirm posts a boardWindow without extra keys', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({} as any);

    await mdfProductionReturnApi.confirm(
      { kind: 'bath', id: 'b1' },
      {
        targetColumn: 'baths',
        boardWindow: { dateFrom: '2026-09-19', dateTo: '2026-09-25', days: 7 } as any,
        expectedDigest: 'digest',
        idempotencyKey: 'key',
      },
    );

    const [, body] = vi.mocked(httpClient.post).mock.calls[0];
    expect(Object.keys((body as any).boardWindow)).toEqual(['dateFrom', 'dateTo']);
  });
});
