import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';

export type MdfEngineMode = 'legacy' | 'shadow' | 'active' | 'read_only';
export interface MdfCommandWriter {
  /** Server-defined owner, never an HTTP parameter or inferred SQL classification. */
  writer: string;
  capability: 'legacy-only' | 'queued' | 'cnc-receipt';
}
const modes = new WeakMap<TransactionClient, Promise<MdfEngineMode>>();

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
  let pending = modes.get(tx);
  if (!pending) {
    pending = loadMode(tx);
    modes.set(tx, pending);
  }
  return checkCapability(await pending, input);
}

/** Nested adapters may inspect existing ownership, never acquire a late fence. */
export async function requireMdfCommandBoundary(tx: TransactionClient, input: MdfCommandWriter) {
  const pending = modes.get(tx);
  if (!pending) throw new ApiError(503, 'MDF_COMMAND_BOUNDARY_REQUIRED', 'Команда не получила границу производственной транзакции');
  return checkCapability(await pending, input);
}

export function discardMdfCommandBoundary(tx: TransactionClient): void { modes.delete(tx); }

function checkCapability(mode: MdfEngineMode, input: MdfCommandWriter) {
  if (mode === 'read_only' && input.capability !== 'cnc-receipt') {
    throw new ApiError(409, 'MDF_ENGINE_READ_ONLY', 'Производственный учёт временно доступен только для чтения');
  }
  if (mode === 'active' && input.capability === 'legacy-only') {
    throw new ApiError(503, 'MDF_WRITER_NOT_CONNECTED', 'Команда ещё не подключена к новому производственному учёту',
      { writer: input.writer });
  }
  return { mode, queued: mode === 'active' || mode === 'read_only' };
}

async function loadMode(tx: TransactionClient): Promise<MdfEngineMode> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
  const rows = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton=true')).rows;
  const mode = rows[0]?.mode;
  if (rows.length === 1 && (mode === 'legacy' || mode === 'shadow' || mode === 'active' || mode === 'read_only')) return mode;
  throw new ApiError(503, 'MDF_ENGINE_STATE_UNAVAILABLE', 'Не удалось определить режим производственного учёта');
}
