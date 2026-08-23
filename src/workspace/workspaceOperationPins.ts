import { recordOrderLifecycleMetric } from '../performance/performanceRum';
import { getWorkspaceStateNamespace } from './workspaceStateNamespace';

/**
 * Operations that are deliberately still owned by their mounted order view.
 *
 * This is a closed catalog, not a detached-operation registry. Adding an id
 * requires a matching owner-matrix row and call-site coverage. Until a row has
 * server-persisted idempotency, reconciliation and notification guarantees,
 * the operation pins its view instead of being retried or re-owned globally.
 */
export const PAGE_OWNED_WORKSPACE_OPERATION_IDS = [
  'order-save',
  'order-refresh',
  'order-delete',
  'order-project-move',
  'order-detail-transfer',
  'order-add-to-cut',
  'order-excel-export',
  'order-snapshot-export',
  'order-excel-import',
  'order-pdf-import',
  'order-vlm-import',
  'order-label-write',
  'order-production-action',
  'order-group-write',
  'order-deadline-write',
  'order-hdf-recalculate',
  'order-telegram-operation',
  'order-bazis-cut',
] as const;

export type PageOwnedWorkspaceOperationId =
  typeof PAGE_OWNED_WORKSPACE_OPERATION_IDS[number];

interface WorkspaceOperationPin {
  namespace: string;
  workspaceKey: string;
  operationId: PageOwnedWorkspaceOperationId;
}

export interface PageOwnedWorkspaceOperationContext {
  workspaceKey: string;
  operationId: PageOwnedWorkspaceOperationId;
  isOwnerCurrent: () => boolean;
  assertOwnerCurrent: () => void;
}

export class WorkspaceOperationOwnershipLostError extends Error {
  constructor() {
    super('Workspace operation owner changed before completion');
    this.name = 'WorkspaceOperationOwnershipLostError';
  }
}

export interface WorkspaceOperationPinDiagnostics {
  activePinCount: number;
  evictionPinCount: number;
}

const pins = new Map<symbol, WorkspaceOperationPin>();
const recordedEvictionIncidents = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
let evictionPinCount = 0;

export function acquireWorkspaceOperationPin(
  workspaceKey: string,
  operationId: PageOwnedWorkspaceOperationId,
): () => void {
  const normalizedWorkspaceKey = workspaceKey.trim();
  if (!normalizedWorkspaceKey) return () => undefined;

  const token = Symbol(operationId);
  const namespace = getWorkspaceStateNamespace();
  pins.set(token, {
    namespace,
    workspaceKey: normalizedWorkspaceKey,
    operationId,
  });
  notify();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (pins.delete(token)) {
      const incidentKey = workspaceIncidentKey(
        namespace,
        normalizedWorkspaceKey,
      );
      if (!hasPinForWorkspace(incidentKey)) {
        recordedEvictionIncidents.delete(incidentKey);
      }
      notify();
    }
  };
}

export async function runPageOwnedWorkspaceOperation<T>(
  workspaceKey: string,
  operationId: PageOwnedWorkspaceOperationId,
  operation: (context: PageOwnedWorkspaceOperationContext) => Promise<T>,
): Promise<T> {
  const namespace = getWorkspaceStateNamespace();
  const release = acquireWorkspaceOperationPin(workspaceKey, operationId);
  const context: PageOwnedWorkspaceOperationContext = {
    workspaceKey,
    operationId,
    isOwnerCurrent: () => getWorkspaceStateNamespace() === namespace,
    assertOwnerCurrent: () => {
      if (getWorkspaceStateNamespace() !== namespace) {
        throw new WorkspaceOperationOwnershipLostError();
      }
    },
  };
  try {
    const result = await operation(context);
    context.assertOwnerCurrent();
    return result;
  } catch (error) {
    // Quarantine both success and failure from an old auth namespace. Without
    // this check, a rejected request from user A could show an error to user B.
    context.assertOwnerCurrent();
    throw error;
  } finally {
    release();
  }
}

export function isWorkspaceOperationOwnershipLost(
  error: unknown,
): error is WorkspaceOperationOwnershipLostError {
  return error instanceof WorkspaceOperationOwnershipLostError;
}

export function hasWorkspaceOperationPins(workspaceKey: string): boolean {
  const namespace = getWorkspaceStateNamespace();
  for (const pin of pins.values()) {
    if (pin.namespace === namespace && pin.workspaceKey === workspaceKey) return true;
  }
  return false;
}

export function listWorkspaceOperationPins(
  workspaceKey: string,
): PageOwnedWorkspaceOperationId[] {
  const namespace = getWorkspaceStateNamespace();
  return [...pins.values()]
    .filter((pin) => pin.namespace === namespace && pin.workspaceKey === workspaceKey)
    .map((pin) => pin.operationId);
}

/** Called by the eviction owner only when an active pin actually blocks eviction. */
export function recordWorkspaceOperationEvictionPin(workspaceKey: string): boolean {
  const normalizedWorkspaceKey = workspaceKey.trim();
  if (!hasWorkspaceOperationPins(normalizedWorkspaceKey)) return false;
  const incidentKey = workspaceIncidentKey(
    getWorkspaceStateNamespace(),
    normalizedWorkspaceKey,
  );
  if (recordedEvictionIncidents.has(incidentKey)) return true;
  recordedEvictionIncidents.add(incidentKey);
  evictionPinCount += 1;
  recordOrderLifecycleMetric('operation_eviction_pin_count', evictionPinCount);
  return true;
}

export function getWorkspaceOperationPinDiagnostics(): WorkspaceOperationPinDiagnostics {
  const namespace = getWorkspaceStateNamespace();
  let activePinCount = 0;
  pins.forEach((pin) => {
    if (pin.namespace === namespace) activePinCount += 1;
  });
  return { activePinCount, evictionPinCount };
}

export function subscribeWorkspaceOperationPins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkspaceOperationPinsRevision(): number {
  return revision;
}

export function clearWorkspaceOperationPins(): void {
  if (pins.size === 0 && evictionPinCount === 0) return;
  pins.clear();
  recordedEvictionIncidents.clear();
  evictionPinCount = 0;
  // Do not publish a zero here: auth cleanup may run before the old RUM batch
  // flushes, and overwriting a non-zero safety incident would make that session
  // look promotion-safe. The next RUM session seeds its own zero baseline.
  notify();
}

function notify(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function workspaceIncidentKey(namespace: string, workspaceKey: string): string {
  return `${namespace}\u0000${workspaceKey}`;
}

function hasPinForWorkspace(incidentKey: string): boolean {
  for (const pin of pins.values()) {
    if (workspaceIncidentKey(pin.namespace, pin.workspaceKey) === incidentKey) return true;
  }
  return false;
}
