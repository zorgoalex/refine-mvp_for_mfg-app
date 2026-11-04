import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';

export type MdfEngineMode = 'legacy' | 'shadow' | 'active' | 'read_only';
export interface MdfCommandWriter {
  /** Server-defined owner, never an HTTP parameter or inferred SQL classification. */
  writer: string;
  capability: 'legacy-only' | 'queued' | 'cnc-receipt' | 'cut-settlement' | 'order-demand' | 'bath-lifecycle' | 'baseline';
}
/** §5.7b: the only writer admitted while a baseline population run is unfinished (durable freeze). */
export const MDF_BASELINE_WRITER = 'mdf.baseline';
/** Ordinary order commands (§5.4a). Their MDF consequence is decided after their own writes by
 * `openMdfOrderCommand`, so read_only admits them past the fence and rejects only an MDF impact. */
export const MDF_ORDER_WRITERS = ['orders.update', 'orders.recalculate_hdf', 'orders.delete',
  'orders.restore', 'orders.transfer_details', 'mdf.demand_reconcile'] as const;
export type MdfOrderWriter = typeof MDF_ORDER_WRITERS[number];
/** Cut commands that may change a job's active bath (§5.4b); impact is decided after their locks. Result
 * archive/unarchive are not here: archiving the current result is refused (409 CUT_RESULT_CURRENT), so they never
 * change which result is the active bath. */
export const MDF_BATH_LIFECYCLE_WRITERS = ['cut.set_current_result', 'cut.manual_layout', 'cut.archive'] as const;
export type MdfBathLifecycleWriter = typeof MDF_BATH_LIFECYCLE_WRITERS[number];
interface Boundary { protocol: 'read-committed' | 'serializable-legacy'; mode: Promise<{ mode: MdfEngineMode; frozen: boolean }> }
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
    boundary = { protocol: 'read-committed', mode: loadMode(tx, input.writer) };
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
    return loadMode(tx, writer, true);
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

function checkCapability(state: { mode: MdfEngineMode; frozen: boolean }, input: MdfCommandWriter) {
  const { mode } = state;
  const baseline = input.capability === 'baseline' && input.writer === MDF_BASELINE_WRITER;
  if (input.capability === 'baseline' && !baseline) {
    throw new ApiError(503,'MDF_WRITER_NOT_CONNECTED','Недопустимый обработчик начального наполнения');
  }
  // §5.7b durable freeze: while a population run is unfinished only the run itself writes, in every mode.
  if (state.frozen !== baseline) {
    if (state.frozen) throw cutoverInProgress();
    throw new ApiError(409,'MDF_BASELINE_NOT_RUNNING','Начальное наполнение не запущено');
  }
  if (baseline) {
    if (mode !== 'read_only') throw new ApiError(409,'MDF_BASELINE_MODE_INVALID','Начальное наполнение требует режима только для чтения');
    return { mode, queued: true };
  }
  // Only closes an already-owned external calculation attempt. This protocol
  // cannot create production evidence, mutate details or dispatch board rules.
  const settlement = input.capability === 'cut-settlement' && input.writer === 'cut.calculate.settlement';
  if (input.capability === 'cut-settlement' && !settlement) {
    throw new ApiError(503,'MDF_WRITER_NOT_CONNECTED','Недопустимый обработчик завершения расчёта');
  }
  const orderDemand = (input.capability === 'order-demand'
    && (MDF_ORDER_WRITERS as readonly string[]).includes(input.writer))
    || (input.capability === 'bath-lifecycle' && (MDF_BATH_LIFECYCLE_WRITERS as readonly string[]).includes(input.writer));
  if ((input.capability === 'order-demand' || input.capability === 'bath-lifecycle') && !orderDemand) {
    throw new ApiError(503,'MDF_WRITER_NOT_CONNECTED','Недопустимый обработчик изменения заказа');
  }
  if (mode === 'read_only' && input.capability !== 'cnc-receipt' && !settlement && !orderDemand) {
    throw new ApiError(409, 'MDF_ENGINE_READ_ONLY', 'Производственный учёт временно доступен только для чтения');
  }
  if (mode === 'active' && input.capability === 'legacy-only') {
    throw new ApiError(503, 'MDF_WRITER_NOT_CONNECTED', 'Команда ещё не подключена к новому производственному учёту',
      { writer: input.writer });
  }
  return { mode, queued: mode === 'active' || mode === 'read_only' };
}

/** True when the current transaction started at or before the last mode change (column added by migration 199). */
export const MDF_MODE_STALE_SQL = "(COALESCE((to_jsonb(s)->>'mode_changed_at')::timestamptz >= transaction_timestamp(),false)"
  + " AND current_setting('mdf.mode_changed_in_tx',true) IS DISTINCT FROM 'on')";
/** Marks the current transaction as the one that changed the mode (transaction-local): it knows the new mode, so it is
 * not stale (the single-transaction baseline dry-run switches mode, records batches and drains jobs, then rolls back). */
export const MDF_MARK_MODE_CHANGED_SQL = "SELECT set_config('mdf.mode_changed_in_tx','on',true)";

function cutoverInProgress(): ApiError {
  return new ApiError(409, 'MDF_CUTOVER_IN_PROGRESS', 'Идёт переключение производственного учёта, повторите позже');
}

/** §5.7b: fail fast, never wait for a population run (the runner holds the exclusive form of this lock). The freeze
 * guard is a LOCKING read on a row only freeze lifecycle transitions update: a stale RR/SERIALIZABLE snapshot aborts
 * with 40001 instead of missing an unfinished run. The writer tag lets the DB fence triggers recognise owned writes. */
async function loadMode(tx: TransactionClient, writer: string, lockState = false): Promise<{ mode: MdfEngineMode; frozen: boolean }> {
  const locked = (await tx.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0)) AS locked")).rows[0]?.locked;
  if (locked !== true) throw cutoverInProgress();
  const rows = (await tx.query<{ mode: string; stale?: boolean }>(`SELECT s.mode,${MDF_MODE_STALE_SQL} stale FROM mdf_engine_state s WHERE s.singleton=true${lockState ? ' FOR SHARE' : ''}`)).rows;
  const mode = rows[0]?.mode;
  if (rows.length !== 1 || !(mode === 'legacy' || mode === 'shadow' || mode === 'active' || mode === 'read_only')) {
    throw new ApiError(503, 'MDF_ENGINE_STATE_UNAVAILABLE', 'Не удалось определить режим производственного учёта');
  }
  // §5.8: a transaction that STARTED at or before the last mode change (activation handoff, recovery mode change) never
  // writes under the new mode: its now()-stamped facts would predate the change and escape the rollback loss check.
  // `mode_changed_at` (migration 199) is DB-stamped on mode changes only; schema-tolerant before 199. Retryable.
  if (rows[0].stale === true) throw cutoverInProgress();
  // §5.8 recovery freeze (migration 199) read schema-tolerantly: before 199 no recovery freeze can exist.
  const guard = (await tx.query<{ freeze_run_id: string | null; recovery: string | null }>(
    "SELECT g.freeze_run_id,to_jsonb(g)->>'recovery_frozen_at' recovery FROM mdf_freeze_guard g WHERE g.singleton=true FOR SHARE")).rows;
  if (guard.length !== 1) throw new ApiError(503, 'MDF_ENGINE_STATE_UNAVAILABLE', 'Не удалось определить режим производственного учёта');
  if (guard[0].recovery != null) {
    throw new ApiError(409, 'MDF_RECOVERY_FREEZE', 'Производственный учёт временно заморожен для восстановления, повторите позже');
  }
  await tx.query("SELECT set_config('mdf.command_writer',$1,true)", [writer]);
  return { mode, frozen: guard[0].freeze_run_id !== null };
}
