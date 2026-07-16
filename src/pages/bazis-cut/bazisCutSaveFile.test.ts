import { describe, expect, it, vi } from 'vitest';
import { saveBazisCutFile } from './bazisCutSaveFile';

describe('saveBazisCutFile', () => {
  it('does not call export when the native picker is cancelled', async () => {
    const fetchFile = vi.fn();
    await expect(saveBazisCutFile({
      suggestedName: 'set.xls', picker: vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')),
      fetchFile, fallbackDownload: vi.fn(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('opens picker first, then fetches and writes the BIFF8 blob', async () => {
    const order: string[] = [];
    const write = vi.fn(async () => { order.push('write'); });
    const close = vi.fn(async () => { order.push('close'); });
    const picker = vi.fn(async () => { order.push('picker'); return { createWritable: async () => ({ write, close }) }; });
    const blob = new Blob(['xls']);
    const fetchFile = vi.fn(async () => { order.push('fetch'); return { blob, fileName: 'server.xls' }; });

    await saveBazisCutFile({ suggestedName: 'set.xls', picker, fetchFile, fallbackDownload: vi.fn() });

    expect(order).toEqual(['picker', 'fetch', 'write', 'close']);
    expect(write).toHaveBeenCalledWith(blob);
  });
});
