import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import {
  captureWorkspaceCheckpoint,
  clearWorkspaceCheckpointRegistry,
  deleteWorkspaceCheckpointAdapterState,
  ensureWorkspaceCheckpoint,
  getWorkspaceCheckpointCounters,
  isWorkspaceCheckpointCircuitOpen,
  readWorkspaceCheckpointAdapterState,
  registerWorkspaceCheckpointAdapter,
} from './workspaceCheckpointRegistry';
import {
  clearWorkspaceUiState,
  readWorkspaceUiCheckpoint,
  writeWorkspaceUiCheckpoint,
} from './workspaceUiStateStore';
import {
  clearWorkspaceAttachments,
  getWorkspaceAttachmentDiagnostics,
  readWorkspaceAttachment,
  retainWorkspaceAttachment,
} from './workspaceAttachmentRegistry';
import { clearWorkspaceSessionState, installWorkspaceStateLifecycle } from './workspaceStateLifecycle';
import { getOrderDraftStore, getOrderDraftStorageKey } from '../stores/orderFormStore';

describe('auth-scoped workspace checkpoint foundation', () => {
  beforeEach(() => {
    installWorkspaceStateLifecycle();
    authSession.clear();
    clearWorkspaceSessionState();
  });

  it('captures multiple adapters synchronously without validating raw input', () => {
    authSession.setUser({ id: 'A', username: 'a', role: 'admin', permissions: ['orders.view'] });
    registerWorkspaceCheckpointAdapter('/orders/edit/42', 'order-form', {
      capture: () => ({ activeTab: 'details', rawInput: '12,' }),
    });
    registerWorkspaceCheckpointAdapter('/orders/edit/42', 'detail-inline', {
      capture: () => ({ editingKey: 7, errors: ['Некорректное число'] }),
    });

    expect(captureWorkspaceCheckpoint('/orders/edit/42')).toBe(true);
    expect(readWorkspaceCheckpointAdapterState('/orders/edit/42', 'order-form')).toEqual({
      activeTab: 'details',
      rawInput: '12,',
    });
    expect(readWorkspaceCheckpointAdapterState('/orders/edit/42', 'detail-inline')).toEqual({
      editingKey: 7,
      errors: ['Некорректное число'],
    });
  });

  it('normalizes optional undefined fields to JSON null', () => {
    writeWorkspaceUiCheckpoint('/orders/edit/42', {
      parser: { optionalSection: undefined, rows: [1, undefined, 3] },
    });
    expect(readWorkspaceUiCheckpoint('/orders/edit/42')?.state).toEqual({
      parser: { optionalSection: null, rows: [1, null, 3] },
    });
  });

  it('keeps the prior checkpoint when recapture is unsafe', () => {
    const canCapture = vi.fn(() => true);
    registerWorkspaceCheckpointAdapter('/orders/show/7', 'show', {
      canCapture,
      capture: () => ({ scrollY: 120 }),
    });
    expect(captureWorkspaceCheckpoint('/orders/show/7')).toBe(true);
    canCapture.mockReturnValue(false);

    expect(captureWorkspaceCheckpoint('/orders/show/7')).toBe(false);
    expect(ensureWorkspaceCheckpoint('/orders/show/7')).toBe(true);
    expect(readWorkspaceCheckpointAdapterState('/orders/show/7', 'show')).toEqual({ scrollY: 120 });
    expect(isWorkspaceCheckpointCircuitOpen()).toBe(true);
    expect(getWorkspaceCheckpointCounters().unsnapshottedTransientSurfaces).toBe(1);
  });

  it('keeps the prior checkpoint when any adapter throws during all-or-nothing capture', () => {
    const unregister = registerWorkspaceCheckpointAdapter('/orders/edit/8', 'form', {
      capture: () => ({ raw: 'first' }),
    });
    expect(captureWorkspaceCheckpoint('/orders/edit/8')).toBe(true);
    unregister();
    registerWorkspaceCheckpointAdapter('/orders/edit/8', 'form', {
      capture: () => ({ raw: 'second' }),
    });
    registerWorkspaceCheckpointAdapter('/orders/edit/8', 'broken', {
      capture: () => { throw new Error('capture failed'); },
    });

    expect(captureWorkspaceCheckpoint('/orders/edit/8')).toBe(false);
    expect(readWorkspaceCheckpointAdapterState('/orders/edit/8', 'form')).toEqual({ raw: 'first' });
    expect(getWorkspaceCheckpointCounters().checkpointCaptureFailures).toBe(1);
  });

  it('deletes a cancelled modal adapter without erasing sibling workspace state', () => {
    writeWorkspaceUiCheckpoint('/orders/edit/8', {
      schemaVersion: 1,
      adapters: {
        'order-form': { activeTab: 'details' },
        'pdf-import-wizard': { open: true, currentStep: 'validation' },
      },
    });

    deleteWorkspaceCheckpointAdapterState('/orders/edit/8', 'pdf-import-wizard');

    expect(readWorkspaceCheckpointAdapterState('/orders/edit/8', 'pdf-import-wizard')).toBeNull();
    expect(readWorkspaceCheckpointAdapterState('/orders/edit/8', 'order-form')).toEqual({
      activeTab: 'details',
    });
  });

  it('rejects binary UI state and keeps it only in the bounded attachment registry', () => {
    const blob = new Blob(['test']);
    expect(() => writeWorkspaceUiCheckpoint('/orders/edit/1', { blob } as never)).toThrow(
      'WORKSPACE_CHECKPOINT_BINARY_MUST_USE_ATTACHMENT_REGISTRY',
    );
    expect(retainWorkspaceAttachment({
      workspaceKey: '/orders/edit/1',
      attachmentKey: 'pdf',
      value: blob,
    })).toBe(true);
    expect(readWorkspaceAttachment('/orders/edit/1', 'pdf')).toBe(blob);
    expect(getWorkspaceAttachmentDiagnostics()).toMatchObject({ count: 1, bytes: 4 });
  });

  it('clears draft-independent checkpoint and attachment references before actor B', () => {
    authSession.setUser({ id: 'A', username: 'a', role: 'admin', permissions: ['orders.view'] });
    registerWorkspaceCheckpointAdapter('/orders/edit/42', 'form', {
      capture: () => ({ dirty: true }),
    });
    retainWorkspaceAttachment({
      workspaceKey: '/orders/edit/42',
      attachmentKey: 'excel',
      value: new Blob(['A']),
    });
    expect(captureWorkspaceCheckpoint('/orders/edit/42')).toBe(true);

    authSession.setUser({ id: 'B', username: 'b', role: 'admin', permissions: ['orders.view'] });

    expect(readWorkspaceUiCheckpoint('/orders/edit/42')).toBeNull();
    expect(readWorkspaceAttachment('/orders/edit/42', 'excel')).toBeNull();
    expect(getWorkspaceAttachmentDiagnostics()).toMatchObject({ count: 0, bytes: 0 });
  });

  it('clears actor-A order drafts and persisted storage before actor B renders', () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    authSession.setUser({ id: 'A', username: 'a', role: 'admin', permissions: ['orders.update'] });
    const actorAStore = getOrderDraftStore('42');
    actorAStore.getState().updateHeaderField('order_name', 'A secret draft');
    const actorAStorageKey = getOrderDraftStorageKey('42');
    expect(storage.getItem(actorAStorageKey)).toContain('A secret draft');

    authSession.setUser({ id: 'B', username: 'b', role: 'admin', permissions: ['orders.update'] });

    expect(actorAStore.getState().header.order_name).toBeUndefined();
    expect(storage.getItem(actorAStorageKey)).toBeNull();
    expect(getOrderDraftStore('42').getState().header.order_name).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('clears the old namespace on same-actor scope revoke', () => {
    authSession.setUser({
      id: 'A', username: 'a', role: 'admin', permissions: ['orders.view', 'orders.update'],
    });
    writeWorkspaceUiCheckpoint('/orders/edit/42', { dirty: true });
    retainWorkspaceAttachment({
      workspaceKey: '/orders/edit/42',
      attachmentKey: 'file',
      value: new Blob(['A']),
    });

    authSession.setUser({
      id: 'A', username: 'a', role: 'admin', permissions: ['orders.view'],
    });

    expect(readWorkspaceUiCheckpoint('/orders/edit/42')).toBeNull();
    expect(readWorkspaceAttachment('/orders/edit/42', 'file')).toBeNull();
  });

  it('keeps the namespace across a token refresh for the same actor and scope', () => {
    authSession.setUser({ id: 'A', username: 'a', role: 'admin', permissions: ['orders.view'] });
    writeWorkspaceUiCheckpoint('/orders/show/1', { panel: 'details' });
    authSession.setAccessToken('token-1');
    authSession.setAccessToken('token-2');
    expect(readWorkspaceUiCheckpoint('/orders/show/1')?.state).toEqual({ panel: 'details' });
  });

  it('requires an explicit bound for parsed workbook objects', () => {
    const workbook = { Sheets: { Sheet1: {} } };
    expect(retainWorkspaceAttachment({
      workspaceKey: '/orders/edit/1',
      attachmentKey: 'workbook',
      value: workbook,
      kind: 'parsed-workbook',
    })).toBe(false);
    expect(retainWorkspaceAttachment({
      workspaceKey: '/orders/edit/1',
      attachmentKey: 'workbook',
      value: workbook,
      kind: 'parsed-workbook',
      estimatedBytes: 1024,
    })).toBe(true);
  });

  it('enforces attachment-count and checkpoint-size bounds', () => {
    for (let index = 0; index < 16; index += 1) {
      expect(retainWorkspaceAttachment({
        workspaceKey: '/orders/edit/1',
        attachmentKey: `blob-${index}`,
        value: new Blob(['x']),
      })).toBe(true);
    }
    expect(retainWorkspaceAttachment({
      workspaceKey: '/orders/edit/1',
      attachmentKey: 'blob-overflow',
      value: new Blob(['x']),
    })).toBe(false);
    expect(() => writeWorkspaceUiCheckpoint('/orders/edit/large', {
      raw: 'x'.repeat(513 * 1024),
    })).toThrow('WORKSPACE_CHECKPOINT_TOO_LARGE');
  });

  it('never persists checkpoints or attachments to browser storage', () => {
    const setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem });
    vi.stubGlobal('localStorage', { setItem });
    writeWorkspaceUiCheckpoint('/orders/show/1', { openSurface: 'finance' });
    retainWorkspaceAttachment({
      workspaceKey: '/orders/show/1',
      attachmentKey: 'blob',
      value: new Blob(['x']),
    });
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}
