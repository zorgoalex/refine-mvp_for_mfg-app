import { recordOrderLifecycleMetric } from '../performance/performanceRum';
import {
  deleteWorkspaceUiCheckpoint,
  hasWorkspaceUiCheckpoint,
  readWorkspaceUiCheckpoint,
  writeWorkspaceUiCheckpoint,
  type WorkspaceSerializableRecord,
} from './workspaceUiStateStore';
import { getWorkspaceStateNamespace } from './workspaceStateNamespace';

export interface WorkspaceCheckpointAdapter {
  capture: () => Record<string, unknown>;
  canCapture?: () => boolean;
}

export interface WorkspaceCheckpointCounters {
  checkpointCaptureFailures: number;
  unsnapshottedTransientSurfaces: number;
}

const adaptersByNamespace = new Map<
  string,
  Map<string, Map<string, WorkspaceCheckpointAdapter>>
>();
let counters: WorkspaceCheckpointCounters = zeroCounters();
let circuitBreaker = false;

export function registerWorkspaceCheckpointAdapter(
  workspaceKey: string,
  adapterKey: string,
  adapter: WorkspaceCheckpointAdapter,
  namespace = getWorkspaceStateNamespace(),
): () => void {
  const workspace = getWorkspaceAdapters(namespace, workspaceKey);
  workspace.set(adapterKey, adapter);
  return () => {
    if (workspace.get(adapterKey) === adapter) workspace.delete(adapterKey);
    if (workspace.size === 0) adaptersByNamespace.get(namespace)?.delete(workspaceKey);
  };
}

export function captureWorkspaceCheckpoint(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): boolean {
  const adapters = adaptersByNamespace.get(namespace)?.get(workspaceKey);
  if (!adapters || adapters.size === 0) return recordMissingAdapter();

  const captured: Record<string, Record<string, unknown>> = {};
  try {
    for (const [adapterKey, adapter] of [...adapters.entries()].sort(([left], [right]) => (
      left.localeCompare(right)
    ))) {
      if (adapter.canCapture?.() === false) return recordMissingAdapter();
      const state = adapter.capture();
      if (isPromiseLike(state)) throw new Error('WORKSPACE_CHECKPOINT_CAPTURE_MUST_BE_SYNCHRONOUS');
      captured[adapterKey] = state;
    }
    writeWorkspaceUiCheckpoint(workspaceKey, {
      schemaVersion: 1,
      adapters: captured,
    }, namespace);
    return true;
  } catch {
    counters = {
      ...counters,
      checkpointCaptureFailures: counters.checkpointCaptureFailures + 1,
    };
    circuitBreaker = true;
    recordOrderLifecycleMetric(
      'checkpoint_capture_failure_count',
      counters.checkpointCaptureFailures,
    );
    return false;
  }
}

export function hasWorkspaceCheckpointAdapters(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): boolean {
  return (adaptersByNamespace.get(namespace)?.get(workspaceKey)?.size ?? 0) > 0;
}

export function captureAllWorkspaceCheckpoints(
  namespace = getWorkspaceStateNamespace(),
): boolean {
  const workspaceKeys = [...(adaptersByNamespace.get(namespace)?.keys() ?? [])];
  return workspaceKeys.every((workspaceKey) => captureWorkspaceCheckpoint(workspaceKey, namespace));
}

export function ensureWorkspaceCheckpoint(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): boolean {
  return hasWorkspaceUiCheckpoint(workspaceKey, namespace)
    || captureWorkspaceCheckpoint(workspaceKey, namespace);
}

export function readWorkspaceCheckpointAdapterState(
  workspaceKey: string,
  adapterKey: string,
  namespace = getWorkspaceStateNamespace(),
): WorkspaceSerializableRecord | null {
  const checkpoint = readWorkspaceUiCheckpoint(workspaceKey, namespace);
  const adapters = checkpoint?.state.adapters;
  if (!adapters || Array.isArray(adapters) || typeof adapters !== 'object') return null;
  const state = adapters[adapterKey];
  return state && !Array.isArray(state) && typeof state === 'object'
    ? state as WorkspaceSerializableRecord
    : null;
}

export function removeWorkspaceCheckpoint(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): void {
  adaptersByNamespace.get(namespace)?.delete(workspaceKey);
  deleteWorkspaceUiCheckpoint(workspaceKey, namespace);
}

export function deleteWorkspaceCheckpointAdapterState(
  workspaceKey: string,
  adapterKey: string,
  namespace = getWorkspaceStateNamespace(),
): void {
  const checkpoint = readWorkspaceUiCheckpoint(workspaceKey, namespace);
  const adapters = checkpoint?.state.adapters;
  if (!adapters || Array.isArray(adapters) || typeof adapters !== 'object') return;
  if (!(adapterKey in adapters)) return;

  const nextAdapters = { ...adapters };
  delete nextAdapters[adapterKey];
  if (Object.keys(nextAdapters).length === 0) {
    deleteWorkspaceUiCheckpoint(workspaceKey, namespace);
    return;
  }
  writeWorkspaceUiCheckpoint(workspaceKey, {
    schemaVersion: 1,
    adapters: nextAdapters,
  }, namespace);
}

export function isWorkspaceCheckpointCircuitOpen(): boolean {
  return circuitBreaker;
}

export function getWorkspaceCheckpointCounters(): WorkspaceCheckpointCounters {
  return { ...counters };
}

export function clearWorkspaceCheckpointRegistry(namespace?: string): void {
  if (namespace) adaptersByNamespace.delete(namespace);
  else adaptersByNamespace.clear();
  circuitBreaker = false;
  counters = zeroCounters();
}

function recordMissingAdapter(): false {
  counters = {
    ...counters,
    unsnapshottedTransientSurfaces: counters.unsnapshottedTransientSurfaces + 1,
  };
  circuitBreaker = true;
  recordOrderLifecycleMetric(
    'unsnapshotted_surface_count',
    counters.unsnapshottedTransientSurfaces,
  );
  return false;
}

function getWorkspaceAdapters(
  namespace: string,
  workspaceKey: string,
): Map<string, WorkspaceCheckpointAdapter> {
  let scoped = adaptersByNamespace.get(namespace);
  if (!scoped) {
    scoped = new Map();
    adaptersByNamespace.set(namespace, scoped);
  }
  let workspace = scoped.get(workspaceKey);
  if (!workspace) {
    workspace = new Map();
    scoped.set(workspaceKey, workspace);
  }
  return workspace;
}

function zeroCounters(): WorkspaceCheckpointCounters {
  return { checkpointCaptureFailures: 0, unsnapshottedTransientSurfaces: 0 };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function';
}
