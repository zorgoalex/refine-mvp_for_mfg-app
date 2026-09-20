/** Transaction-local persistence only. No external I/O or new domain locks in
 * finalizers: all owning commands must finish their domain writes first. */
interface Hooks { closed: boolean; callbacks: Map<string, () => Promise<void>> }
const hooks = new WeakMap<object, Hooks>();

export function beginTransactionHooks(tx: object): void {
  if (hooks.has(tx)) throw new Error('TRANSACTION_HOOKS_ALREADY_OPEN');
  hooks.set(tx, { closed: false, callbacks: new Map() });
}
export function beforeTransactionCommit(tx: object, key: string, callback: () => Promise<void>): void {
  const state = hooks.get(tx);
  if (!state) throw new Error('TRANSACTION_HOOKS_UNAVAILABLE');
  if (state.closed) throw new Error('TRANSACTION_HOOKS_CLOSED');
  if (!state.callbacks.has(key)) state.callbacks.set(key, callback);
}
export async function flushTransactionHooks(tx: object): Promise<void> {
  const state = hooks.get(tx);
  if (!state) throw new Error('TRANSACTION_HOOKS_UNAVAILABLE');
  if (state.closed) throw new Error('TRANSACTION_HOOKS_CLOSED');
  state.closed = true;
  for (const key of [...state.callbacks.keys()].sort()) await state.callbacks.get(key)!();
}
export function discardTransactionHooks(tx: object): void { hooks.delete(tx); }
