/**
 * «Переделка» from a status picker: the status «Переделка» is never set directly (a DB guard admits it only from the rework
 * command), so choosing it anywhere asks the app-level host to open the rework form for the order instead.
 */

export interface ReworkStartRequest {
  orderId: number;
  /** After a successful start/extend — the caller re-reads its data (at least the command's order version). */
  onDone?: (result: { version: number }) => void;
}

type Listener = (request: ReworkStartRequest) => void;

const listeners = new Set<Listener>();

export function requestReworkStart(request: ReworkStartRequest): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) listener(request);
  return true;
}

export function subscribeReworkStart(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The order status «Переделка» (by code; the name may be renamed in the reference). */
export function isReworkOrderStatus(status: { code?: string | null } | null | undefined): boolean {
  return status?.code === 'rework';
}
