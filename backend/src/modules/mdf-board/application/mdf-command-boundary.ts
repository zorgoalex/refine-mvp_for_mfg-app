import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';

export type MdfEngineMode = 'legacy' | 'shadow' | 'active' | 'read_only';
export interface MdfCommandWriter {
  /** Server-defined owner, never an HTTP parameter or inferred SQL classification. */
  writer: string;
  capability: 'legacy-only' | 'queued' | 'cnc-receipt' | 'cut-settlement';
}
interface Boundary { protocol: 'read-committed' | 'serializable-legacy'; mode: Promise<MdfEngineMode> }
const modes = new WeakMap<TransactionClient, Boundary>();

/** Owning transaction calls this BEFORE any project/order/source locks or
 * mutations. It is not a late event-dispatch guard. Cutover takes the exclusive
 * form of this lock, so mode cannot change until this command commits/rolls back.
 * READ COMMITTED and fresh wrapper required (DatabaseService guarantees both).
 * Lock and mode read MUST remain separate statements: one statement would keep
 * its pre-lock-wait snapshot. Never
 * disable this fence by a process-local flag or treat a missing schema as legacy.
 * Capability is checked on EVERY entry, even when mode has already been cached.
 */
export async function enterMdfCommand(tx: TransactionClient, input: MdfCommandWriter): Promise<{
  mode: MdfEngineMode; queued: boolean;
}> {
  let boundary = modes.get(tx);
  if (boundary?.protocol === 'serializable-legacy') unsupportedIsolation();
  if (!boundary) {
    boundary = { protocol: 'read-committed', mode: loadMode(tx) };
    modes.set(tx, boundary);
  }
  return checkCapability(await boundary.mode, input);
}

/** Dedicated legacy-return entrance, BEFORE domain reads/locks and savepoints.
 * Preserve SERIALIZABLE preview consistency without trusting its old snapshot:
 * FOR SHARE forces 40001 if the mode row changed after snapshot creation while
 * waiting for cutover. A plain SELECT here could authorize a stale legacy mode.
 * This is never a queued-command entrance; do not widen its fixed capability.
 */
export async function enterMdfSerializableLegacyCommand(tx: TransactionClient, writer: string) {
  if (modes.has(tx)) throw new ApiError(503, 'MDF_COMMAND_BOUNDARY_CONFLICT', 'Производственная граница уже установлена');
  const mode = (async () => {
    const isolation = (await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
    if (isolation !== 'serializable') unsupportedIsolation();
    return loadMode(tx, true);
  })();
  modes.set(tx, { protocol: 'serializable-legacy', mode });
  return checkCapability(await mode, { writer, capability: 'legacy-only' });
}

/** Nested adapters may inspect existing ownership, never acquire a late fence. */
export async function requireMdfCommandBoundary(tx: TransactionClient, input: MdfCommandWriter) {
  const boundary = modes.get(tx);
  if (!boundary) throw new ApiError(503, 'MDF_COMMAND_BOUNDARY_REQUIRED', 'Команда не получила границу производственной транзакции');
  if (boundary.protocol === 'serializable-legacy' && input.capability !== 'legacy-only') unsupportedIsolation();
  return checkCapability(await boundary.mode, input);
}

export function discardMdfCommandBoundary(tx: TransactionClient): void { modes.delete(tx); }

function unsupportedIsolation(): never {
  throw new ApiError(503, 'MDF_COMMAND_ISOLATION_UNSUPPORTED', 'Команда требует отдельного протокола производственной транзакции');
}

function checkCapability(mode: MdfEngineMode, input: MdfCommandWriter) {
  // Only closes an already-owned external calculation attempt. This protocol
  // cannot create production evidence, mutate details or dispatch board rules.
  const settlement = input.capability === 'cut-settlement' && input.writer === 'cut.calculate.settlement';
  if (input.capability === 'cut-settlement' && !settlement) {
    throw new ApiError(503,'MDF_WRITER_NOT_CONNECTED','Недопустимый обработчик завершения расчёта');
  }
  if (mode === 'read_only' && input.capability !== 'cnc-receipt' && !settlement) {
    throw new ApiError(409, 'MDF_ENGINE_READ_ONLY', 'Производственный учёт временно доступен только для чтения');
  }
  if (mode === 'active' && input.capability === 'legacy-only') {
    throw new ApiError(503, 'MDF_WRITER_NOT_CONNECTED', 'Команда ещё не подключена к новому производственному учёту',
      { writer: input.writer });
  }
  return { mode, queued: mode === 'active' || mode === 'read_only' };
}

async function loadMode(tx: TransactionClient, lockState = false): Promise<MdfEngineMode> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
  const rows = (await tx.query<{ mode: string }>(`SELECT mode FROM mdf_engine_state WHERE singleton=true${lockState ? ' FOR SHARE' : ''}`)).rows;
  const mode = rows[0]?.mode;
  if (rows.length === 1 && (mode === 'legacy' || mode === 'shadow' || mode === 'active' || mode === 'read_only')) return mode;
  throw new ApiError(503, 'MDF_ENGINE_STATE_UNAVAILABLE', 'Не удалось определить режим производственного учёта');
}
