import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCncTelegramImport } from './useCncTelegramImport';
import { cncTelegramImportApi } from '../api/cncTelegramImportApi';

const invalidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@refinedev/core', () => ({ useInvalidate: () => invalidate }));
vi.mock('../api/cncTelegramImportApi', () => ({
  createCncTelegramImportIdempotencyKey: () => 'test-key',
  cncTelegramImportApi: { createScan: vi.fn(), prepare: vi.fn(), prepareRepeat: vi.fn(), getRequest: vi.fn() },
}));

let state: ReturnType<typeof useCncTelegramImport>;
let root: ReactTestRenderer;
function Harness() { state = useCncTelegramImport(false); return null; }
const api = vi.mocked(cncTelegramImportApi);
const prepared = { importRequestId: 'draft-1', confirmationId: 'confirm-1', candidates: [] } as never;
describe('Telegram prepared-number lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { clearInterval, localStorage: { setItem: vi.fn(), removeItem: vi.fn() } });
    api.createScan.mockResolvedValue({ scanId: 'scan-1', status: 'ready' } as never);
    api.prepare.mockResolvedValue(prepared);
    api.prepareRepeat.mockResolvedValue(prepared);
    act(() => { root = create(<Harness />); });
  });
  afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
  it('carries exact abandoned draft identity when changing numbers after going back', async () => {
    await act(async () => { await state.startScan({ dateFrom: '2026-09-05', dateTo: '2026-09-05' }); });
    await act(async () => { await state.prepareImport(['first'], { first: 42 }); });
    act(() => state.returnToSelection());
    await act(async () => { await state.prepareImport(['first'], { first: 55 }); });
    expect(api.prepare).toHaveBeenLastCalledWith('scan-1', {
      candidateIds: ['first'], requestedCutJobIds: { first: 55 },
      replaceDraft: { importRequestId: 'draft-1', confirmationId: 'confirm-1' },
    }, 'test-key');
  });
  it('also carries replacement identity for a repeated import, then clears it for a fresh scan', async () => {
    await act(async () => { await state.prepareRepeat('original', ['first'], { first: 42 }); });
    act(() => state.returnToSelection());
    await act(async () => { await state.prepareRepeat('original', ['first'], { first: 55 }); });
    expect(api.prepareRepeat).toHaveBeenLastCalledWith('original', ['first'], 'test-key', { first: 55 },
      { importRequestId: 'draft-1', confirmationId: 'confirm-1' });
    act(() => state.returnToSelection());
    await act(async () => { await state.startScan({ dateFrom: '2026-09-05', dateTo: '2026-09-05' }); });
    await act(async () => { await state.prepareImport(['first'], {}); });
    expect(api.prepare).toHaveBeenLastCalledWith('scan-1', { candidateIds: ['first'], requestedCutJobIds: {} }, 'test-key');
  });
  it('restores candidates from a persisted request so retry stays editable after reload', async () => {
    api.getRequest.mockResolvedValue({ importRequestId: 'original', status: 'failed', candidates: [{ candidateId: 'first' }], items: [] } as never);
    await act(async () => { await state.refreshImport('original'); });
    expect(state.candidates).toEqual([{ candidateId: 'first' }]);
  });
});
