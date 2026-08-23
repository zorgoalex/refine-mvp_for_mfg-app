import type { WorkspaceSerializableRecord } from './workspaceUiStateStore';

export interface WorkspaceDomCheckpoint extends WorkspaceSerializableRecord {
  scrollY: number;
  focus: WorkspaceSerializableRecord | null;
}

export function captureWorkspaceDomCheckpoint(workspaceKey: string): WorkspaceDomCheckpoint {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { scrollY: 0, focus: null };
  }
  const roots = findWorkspaceRoots(workspaceKey);
  const active = document.activeElement;
  return {
    scrollY: Math.max(0, Number.isFinite(window.scrollY) ? window.scrollY : 0),
    focus: active instanceof HTMLElement && roots.some((root) => root.contains(active))
      ? captureFocusableElement(active)
      : null,
  };
}

export function restoreWorkspaceDomCheckpoint(
  workspaceKey: string,
  checkpoint: WorkspaceSerializableRecord | null,
): () => void {
  if (!checkpoint || typeof document === 'undefined' || typeof window === 'undefined') {
    return () => undefined;
  }
  let cancelled = false;
  const restore = () => {
    if (cancelled) return;
    const scrollY = typeof checkpoint.scrollY === 'number' && Number.isFinite(checkpoint.scrollY)
      ? Math.max(0, checkpoint.scrollY)
      : 0;
    window.scrollTo({ top: scrollY });
    const focus = checkpoint.focus;
    if (!focus || typeof focus !== 'object' || Array.isArray(focus)) return;
    const element = findFocusableElement(workspaceKey, focus);
    if (!element) return;
    if (typeof focus.rawValue === 'string' && isTextEntry(element)) {
      element.value = focus.rawValue;
    }
    element.focus({ preventScroll: true });
    if (isTextEntry(element)) {
      const start = typeof focus.selectionStart === 'number' ? focus.selectionStart : null;
      const end = typeof focus.selectionEnd === 'number' ? focus.selectionEnd : start;
      if (start !== null) element.setSelectionRange(start, end);
    }
  };
  const firstFrame = window.requestAnimationFrame(() => {
    window.requestAnimationFrame(restore);
  });
  return () => {
    cancelled = true;
    window.cancelAnimationFrame(firstFrame);
  };
}

function captureFocusableElement(element: HTMLElement): WorkspaceSerializableRecord | null {
  const workspaceField = element.getAttribute('data-workspace-field');
  const name = element.getAttribute('name');
  const identity = workspaceField
    ? { kind: 'workspace-field', value: workspaceField }
    : element.id
      ? { kind: 'id', value: element.id }
      : name
        ? { kind: 'name', value: name }
        : null;
  if (!identity) return null;
  return {
    ...identity,
    ...(isTextEntry(element)
      ? {
          rawValue: element.value,
          selectionStart: element.selectionStart ?? 0,
          selectionEnd: element.selectionEnd ?? element.selectionStart ?? 0,
        }
      : {}),
  };
}

function findFocusableElement(
  workspaceKey: string,
  identity: WorkspaceSerializableRecord,
): HTMLElement | null {
  if (typeof identity.value !== 'string') return null;
  const candidates = findWorkspaceRoots(workspaceKey).flatMap((root) => (
    [...root.querySelectorAll<HTMLElement>('[id], [name], [data-workspace-field]')]
  ));
  return [...candidates].find((candidate) => {
    if (identity.kind === 'id') return candidate.id === identity.value;
    if (identity.kind === 'name') return candidate.getAttribute('name') === identity.value;
    return identity.kind === 'workspace-field'
      && candidate.getAttribute('data-workspace-field') === identity.value;
  }) ?? null;
}

function findWorkspaceRoots(workspaceKey: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(
    '[data-workspace-key], [data-workspace-portal-key]',
  )].filter((element) => (
    element.dataset.workspaceKey === workspaceKey
    || element.dataset.workspacePortalKey === workspaceKey
  ));
}

function isTextEntry(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}
