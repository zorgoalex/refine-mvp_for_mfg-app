import { getWorkspaceStateNamespace } from './workspaceStateNamespace';

export interface WorkspaceKeepAliveDiagnostics {
  mountedHeavyViewCount: number;
  peakMountedHeavyViewCount: number;
}

let namespace = '';
let mountedHeavyViewCount = 0;
let peakMountedHeavyViewCount = 0;

export function recordMountedHeavyViewCount(count: number): WorkspaceKeepAliveDiagnostics {
  ensureCurrentNamespace();
  mountedHeavyViewCount = normalizeCount(count);
  peakMountedHeavyViewCount = Math.max(peakMountedHeavyViewCount, mountedHeavyViewCount);
  return getWorkspaceKeepAliveDiagnostics();
}

export function getWorkspaceKeepAliveDiagnostics(): WorkspaceKeepAliveDiagnostics {
  ensureCurrentNamespace();
  return { mountedHeavyViewCount, peakMountedHeavyViewCount };
}

export function clearWorkspaceKeepAliveDiagnostics(): void {
  namespace = '';
  mountedHeavyViewCount = 0;
  peakMountedHeavyViewCount = 0;
}

function ensureCurrentNamespace(): void {
  const currentNamespace = getWorkspaceStateNamespace();
  if (namespace === currentNamespace) return;
  namespace = currentNamespace;
  mountedHeavyViewCount = 0;
  peakMountedHeavyViewCount = 0;
}

function normalizeCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}
