import { isApiError } from '../../api/apiError';

/**
 * The backend rejects a cut-result/cut-job write with one of these 409/428
 * codes when the change touches the job's active MDF bath — make-current,
 * job delete/archive, manual-layout save, and calculate can all return them.
 * See backend/src/modules/mdf-board/adapters/mdf-bath-lifecycle.ts.
 */
export const MDF_BATH_ERROR_CODES = [
  'MDF_BATH_HAS_PRODUCTION',
  'MDF_BATH_TRANSITION_PENDING',
  'MDF_BATH_RESULT_RETIRED',
  'MDF_BATH_LIFECYCLE_STALE',
  'CUT_JOB_STALE_VERSION',
  'MDF_BATH_SUCCESSOR_INVALID',
  'MDF_ENGINE_READ_ONLY',
  'MDF_BATH_FENCE_REQUIRED',
] as const;

export type MdfBathErrorCode = (typeof MDF_BATH_ERROR_CODES)[number];

const MDF_BATH_ERROR_CODE_SET: ReadonlySet<string> = new Set(MDF_BATH_ERROR_CODES);

// Only these two mean the client's view of the job is out of date — the
// backend message asks the user to reload, so the caller does it for them.
// The other codes ask for a different remedy (retry later, recalculate, undo
// the production step first), so reloading the job is not the fix.
const MDF_BATH_ERROR_RELOAD_CODES: ReadonlySet<string> = new Set([
  'MDF_BATH_LIFECYCLE_STALE',
  'CUT_JOB_STALE_VERSION',
]);

// Backend error.message is already Russian; these only cover a missing/empty
// message (defensive — should not happen against the real backend).
const MDF_BATH_ERROR_FALLBACK_MESSAGES: Record<MdfBathErrorCode, string> = {
  MDF_BATH_HAS_PRODUCTION: 'Ванна уже закатана — сначала оформите возврат закатки',
  MDF_BATH_TRANSITION_PENDING: 'Предыдущее изменение ванны ещё обрабатывается — повторите позже',
  MDF_BATH_RESULT_RETIRED: 'Этот вариант раскроя уже выведен из МДФ-учёта — пересчитайте раскрой',
  MDF_BATH_LIFECYCLE_STALE: 'Раскрой изменился — обновите страницу',
  CUT_JOB_STALE_VERSION: 'Раскрой изменился — обновите страницу',
  MDF_BATH_SUCCESSOR_INVALID: 'Состав выбранного раскроя больше не совпадает с заказами — пересчитайте раскрой',
  MDF_ENGINE_READ_ONLY: 'Производственный учёт временно доступен только для чтения',
  MDF_BATH_FENCE_REQUIRED: 'Нужны версия задания и ключ идемпотентности',
};

export interface MdfBathErrorView {
  code: MdfBathErrorCode;
  message: string;
  /** true = the caller should reload the job before letting the user retry. */
  reload: boolean;
}

export function isMdfBathErrorCode(code: unknown): code is MdfBathErrorCode {
  return typeof code === 'string' && MDF_BATH_ERROR_CODE_SET.has(code);
}

/**
 * Detects one of the MDF-bath lifecycle codes on an error from make-current,
 * job delete/archive, manual-layout save, or calculate, and builds a
 * ready-to-show view model. Returns null when the error is not one of these
 * codes, so callers fall back to their generic error handling.
 */
export function buildMdfBathErrorView(error: unknown): MdfBathErrorView | null {
  if (!isApiError(error) || !isMdfBathErrorCode(error.code)) return null;
  const code = error.code;
  const message = typeof error.message === 'string' && error.message.trim()
    ? error.message
    : MDF_BATH_ERROR_FALLBACK_MESSAGES[code];
  return {
    code,
    message,
    reload: MDF_BATH_ERROR_RELOAD_CODES.has(code),
  };
}

const DEFINITIVE_CALCULATION_CODES = new Set([
  'CUT_STALE_VERSION',
  'CUT_RESULT_COMMAND_CONFLICT',
  'CUT_RESULT_COMMAND_FAILED',
  'CUT_RESULT_COMMAND_ABANDONED',
  'CUT_JOB_NOT_MUTABLE',
]);

/**
 * A server answer after which the calculation command must never be replayed (it is settled or unusable):
 * the listed cut codes and every MDF bath rejection. Transport/unknown errors are NOT definitive — their
 * commandId is kept so an idempotent retry deduplicates.
 */
export function isDefinitiveCalculationRejection(error: unknown): boolean {
  if (buildMdfBathErrorView(error) !== null) return true;
  return isApiError(error) && DEFINITIVE_CALCULATION_CODES.has(error.code);
}

/**
 * Synchronous single-flight gate: while one run is in flight (including any await before the actual command),
 * further calls return immediately without running. Used so overlapping «Рассчитать» clicks can never mint a
 * second calculation command.
 */
export function createSingleFlight(): <T>(run: () => Promise<T>) => Promise<T | undefined> {
  let inFlight = false;
  return async <T>(run: () => Promise<T>) => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await run();
    } finally {
      inFlight = false;
    }
  };
}

