import { getWorkspaceStateNamespace } from './workspaceStateNamespace';

export type WorkspaceSerializable =
  | null
  | boolean
  | number
  | string
  | WorkspaceSerializable[]
  | { [key: string]: WorkspaceSerializable };

export type WorkspaceSerializableRecord = Record<string, WorkspaceSerializable>;

export interface WorkspaceUiCheckpoint {
  schemaVersion: 1;
  capturedAt: number;
  state: WorkspaceSerializableRecord;
}

const MAX_CHECKPOINTS_PER_NAMESPACE = 32;
const MAX_CHECKPOINT_BYTES = 512 * 1024;
const MAX_SERIALIZATION_DEPTH = 32;
const checkpointsByNamespace = new Map<string, Map<string, WorkspaceUiCheckpoint>>();

export function writeWorkspaceUiCheckpoint(
  workspaceKey: string,
  state: Record<string, unknown>,
  namespace = getWorkspaceStateNamespace(),
): WorkspaceUiCheckpoint {
  const clonedState = cloneWorkspaceSerializableRecord(state);
  const encoded = JSON.stringify(clonedState);
  if (byteLength(encoded) > MAX_CHECKPOINT_BYTES) {
    throw new Error('WORKSPACE_CHECKPOINT_TOO_LARGE');
  }

  const scoped = getNamespaceMap(namespace);
  if (!scoped.has(workspaceKey) && scoped.size >= MAX_CHECKPOINTS_PER_NAMESPACE) {
    const oldestKey = [...scoped.entries()]
      .sort(([, left], [, right]) => left.capturedAt - right.capturedAt)[0]?.[0];
    if (oldestKey) scoped.delete(oldestKey);
  }

  const checkpoint: WorkspaceUiCheckpoint = {
    schemaVersion: 1,
    capturedAt: Date.now(),
    state: clonedState,
  };
  scoped.set(workspaceKey, checkpoint);
  return cloneCheckpoint(checkpoint);
}

export function readWorkspaceUiCheckpoint(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): WorkspaceUiCheckpoint | null {
  const checkpoint = checkpointsByNamespace.get(namespace)?.get(workspaceKey);
  return checkpoint ? cloneCheckpoint(checkpoint) : null;
}

export function hasWorkspaceUiCheckpoint(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): boolean {
  return checkpointsByNamespace.get(namespace)?.has(workspaceKey) === true;
}

export function deleteWorkspaceUiCheckpoint(
  workspaceKey: string,
  namespace = getWorkspaceStateNamespace(),
): void {
  const scoped = checkpointsByNamespace.get(namespace);
  scoped?.delete(workspaceKey);
  if (scoped?.size === 0) checkpointsByNamespace.delete(namespace);
}

export function clearWorkspaceUiState(namespace?: string): void {
  if (namespace) checkpointsByNamespace.delete(namespace);
  else checkpointsByNamespace.clear();
}

export function getWorkspaceUiStateDiagnostics(): { namespaces: number; checkpoints: number } {
  let checkpoints = 0;
  checkpointsByNamespace.forEach((scoped) => {
    checkpoints += scoped.size;
  });
  return { namespaces: checkpointsByNamespace.size, checkpoints };
}

function getNamespaceMap(namespace: string): Map<string, WorkspaceUiCheckpoint> {
  let scoped = checkpointsByNamespace.get(namespace);
  if (!scoped) {
    scoped = new Map();
    checkpointsByNamespace.set(namespace, scoped);
  }
  return scoped;
}

function cloneCheckpoint(checkpoint: WorkspaceUiCheckpoint): WorkspaceUiCheckpoint {
  return {
    ...checkpoint,
    state: cloneWorkspaceSerializableRecord(checkpoint.state),
  };
}

function cloneWorkspaceSerializableRecord(value: Record<string, unknown>): WorkspaceSerializableRecord {
  return cloneWorkspaceSerializable(value, 0, new Set()) as WorkspaceSerializableRecord;
}

function cloneWorkspaceSerializable(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): WorkspaceSerializable {
  if (depth > MAX_SERIALIZATION_DEPTH) throw new Error('WORKSPACE_CHECKPOINT_TOO_DEEP');
  // Match JSON semantics without ever storing an actual `undefined` value.
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('WORKSPACE_CHECKPOINT_NON_FINITE_NUMBER');
    return value;
  }
  if (typeof value !== 'object') throw new Error('WORKSPACE_CHECKPOINT_NOT_SERIALIZABLE');
  if (isBinaryLike(value)) throw new Error('WORKSPACE_CHECKPOINT_BINARY_MUST_USE_ATTACHMENT_REGISTRY');
  if (ancestors.has(value)) throw new Error('WORKSPACE_CHECKPOINT_CYCLIC');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneWorkspaceSerializable(item, depth + 1, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('WORKSPACE_CHECKPOINT_NON_PLAIN_OBJECT');
    }
    const cloned: Record<string, WorkspaceSerializable> = {};
    for (const [key, nested] of Object.entries(value)) {
      cloned[key] = cloneWorkspaceSerializable(nested, depth + 1, ancestors);
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function isBinaryLike(value: object): boolean {
  return (typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof File !== 'undefined' && value instanceof File)
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value);
}

function byteLength(value: string): number {
  return typeof TextEncoder === 'function'
    ? new TextEncoder().encode(value).byteLength
    : value.length * 2;
}
