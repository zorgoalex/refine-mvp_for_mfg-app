import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CadVariant } from '@shared/cad-workspace';
import { CadAutosave } from './cadAutosave';
const base: CadVariant = { id: 'v', workspaceId: 'w', kind: 'working', name: 'Рабочая', version: 1, sources: [],
  groups: [{ id: 'g', sourceSnapshotId: 's', orderId: 1, detailId: 1, quantity: 1, recipe: null, xMm: 0, yMm: 0, rotationDeg: 0 }],
  createdAt: '', parentId: null, jobId: null, renderRevision: null };
const draft = (x: number) => ({ sources: [], groups: base.groups.map(g => ({ ...g, xMm: x })) });
afterEach(() => vi.useRealTimers());
describe('CAD autosave', () => {
  it('debounces 700ms and marks saved only after acknowledgement', async () => {
    vi.useFakeTimers();
    let ack!: (v: CadVariant) => void;
    const transport = vi.fn(() => new Promise<CadVariant>(resolve => { ack = resolve; }));
    const queue = new CadAutosave(base, transport, () => 'key');
    queue.edit(draft(1)); await vi.advanceTimersByTimeAsync(699); expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(queue.snapshot().status).toBe('saving');
    ack({ ...base, ...draft(1), version: 2 }); await queue.flush(); expect(queue.snapshot().status).toBe('saved'); queue.dispose();
  });
  it('serializes requests and sends only the latest pending draft using ACK revision', async () => {
    let ack!: (v: CadVariant) => void;
    const transport = vi.fn().mockImplementationOnce(() => new Promise<CadVariant>(resolve => { ack = resolve; }))
      .mockImplementation(async (v: CadVariant, groups: CadVariant['groups']) => ({ ...v, groups, version: v.version + 1 }));
    const queue = new CadAutosave(base, transport, () => 'key');
    queue.edit(draft(1)); const pending = queue.flush(); queue.edit(draft(2)); queue.edit(draft(3));
    expect(transport).toHaveBeenCalledTimes(1); ack({ ...base, ...draft(1), version: 2 }); await pending;
    expect(transport).toHaveBeenCalledTimes(2); expect(transport.mock.calls[1][0].version).toBe(2);
    expect(queue.snapshot().base.groups[0].xMm).toBe(3); queue.dispose();
  });
  it('retries the same failed body/key before saving subsequent edits', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementation(async (v: CadVariant, groups: CadVariant['groups']) => ({ ...v, groups, version: v.version + 1 }));
    let n = 0; const queue = new CadAutosave(base, transport, () => `key${++n}`);
    queue.edit(draft(1)); await expect(queue.flush()).rejects.toThrow('network'); queue.edit(draft(2)); await queue.flush();
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1]); expect(transport.mock.calls[2][3]).toBe('key2'); queue.dispose();
  });
  it('stops on CAS conflict and retains exact base plus latest draft for atomic fork', async () => {
    const transport = vi.fn().mockRejectedValue({ code: 'CAD_STALE_VERSION' }); const queue = new CadAutosave(base, transport, () => 'key');
    queue.edit(draft(7)); await expect(queue.flush()).rejects.toMatchObject({ code: 'CAD_STALE_VERSION' });
    queue.accept({ ...base, version: 9 }); await expect(queue.flush()).rejects.toThrow('конфликт');
    expect(queue.snapshot().base.version).toBe(1); expect(queue.snapshot().draft.groups[0].xMm).toBe(7); expect(transport).toHaveBeenCalledTimes(1); queue.dispose();
  });
  it('replaces a deterministically rejected body after the user corrects it', async () => {
    const transport = vi.fn().mockRejectedValueOnce({ status: 403, code: 'CAD_TECHNOLOGY_REQUIRED' })
      .mockImplementation(async (v: CadVariant, groups: CadVariant['groups']) => ({ ...v, groups, version: v.version + 1 }));
    let n = 0; const queue = new CadAutosave(base, transport, () => `key${++n}`);
    queue.edit(draft(100)); await expect(queue.flush()).rejects.toMatchObject({ status: 403 });
    queue.edit(draft(10)); expect(queue.snapshot().status).toBe('dirty'); await queue.flush();
    expect(transport.mock.calls[1][1][0].xMm).toBe(10); expect(transport.mock.calls[1][3]).toBe('key2');
    expect(queue.snapshot().status).toBe('saved'); queue.dispose();
  });
  it('blocks export while a field is incomplete, never saves hidden older values', async () => {
    const transport = vi.fn(); const queue = new CadAutosave(base, transport); queue.setIncomplete(true);
    await expect(queue.flush()).rejects.toThrow('Завершите ввод'); expect(transport).not.toHaveBeenCalled(); queue.dispose();
  });
});
