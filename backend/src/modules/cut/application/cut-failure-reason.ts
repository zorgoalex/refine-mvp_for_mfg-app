/**
 * Single source of truth that turns a cut-calculation failure into a stable
 * machine code plus a human-readable Russian sentence for the operator.
 *
 * A calculation can fail in two phases of {@link PgCutRepository.calculate}:
 *   - Phase 1 (validation, under lock): no items, no sheet spec, instance/body
 *     limits, invalid grain config.
 *   - Phase 2 (external freecut optimization): constraint/timeout/overload/etc.
 * BOTH are mapped here so the persisted cut_job.failure_reason (migration 032)
 * and the ApiError re-thrown on the live request always carry the SAME human
 * text, never raw English or an unexplained bare "Ошибка".
 *
 * Concurrency / precondition errors (stale version, not-mutable, not-found) are
 * NOT calculation outcomes: {@link shouldMarkCutFailed} keeps them from marking
 * the job failed or overwriting its persisted reason.
 */

import { ApiError } from '../../../common/errors/api-error';

/** Sentinel code stored when the failure does not map to a known code. */
export const CUT_FAILURE_FALLBACK_CODE = 'CUT_CALCULATE_FAILED';

export interface CutFailureInfo {
  /** Stable, query/analytics-friendly machine code. */
  code: string;
  /** Operator-facing Russian explanation. */
  reason: string;
}

const FALLBACK_REASON =
  'Не удалось рассчитать раскрой из-за внутренней ошибки. Повторите попытку; если ошибка повторяется — обратитесь к администратору.';

/**
 * Error codes that represent a precondition/concurrency rejection rather than a
 * calculation outcome. They must NOT mark the job failed nor touch its reason.
 */
const PASSTHROUGH_CODES = new Set<string>([
  'CUT_STALE_VERSION',
  'CUT_JOB_NOT_MUTABLE',
  'CUT_JOB_NOT_FOUND',
  'CUT_JOB_ITEM_NOT_FOUND',
  'ORDER_DETAIL_NOT_FOUND',
  // Precondition: the chosen cut profile was deactivated after selection;
  // operator must clear or re-pick the profile before recalculating — no solve was attempted.
  'CUT_PARAM_PROFILE_NOT_FOUND',
  // Precondition: the chosen sheet was deactivated/made non-cuttable after selection;
  // operator must re-pick an active cuttable sheet before recalculating — no solve was attempted.
  'CUT_SHEET_MATERIAL_NOT_CUTTABLE',
  'PERMISSION_DENIED',
  'AUTH_REQUIRED',
]);

/** Known freecut + cut-domain validation codes → operator reasons. */
const REASON_BY_CODE: Record<string, string> = {
  // Phase 2 — external freecut optimizer (see FreecutClient.mapErrorResponse).
  FREECUT_CONSTRAINT_ERROR:
    'Детали не помещаются на лист при текущих параметрах раскроя. Уменьшите размеры деталей, разбейте задание или выберите другой лист.',
  FREECUT_REQUEST_TOO_LARGE:
    'Слишком много деталей в одном раскрое для оптимизатора. Разбейте задание на несколько меньших.',
  FREECUT_VALIDATION_ERROR:
    'Некорректные данные деталей или листа для раскроя (размеры или количество). Проверьте детали и спецификацию материала.',
  FREECUT_TIMEOUT:
    'Оптимизатор не успел рассчитать раскрой за отведённое время. Повторите расчёт или уменьшите количество деталей.',
  FREECUT_OVERLOADED:
    'Сервис раскроя сейчас перегружен. Повторите расчёт через минуту.',
  FREECUT_PROVIDER_ERROR:
    'Сервис раскроя временно недоступен. Повторите расчёт позже.',
  // Phase 1 — cut-domain validation (pre-call guards).
  CUT_NO_ITEMS:
    'В раскрое нет деталей, готовых к расчёту. Добавьте подходящие детали и повторите расчёт.',
  CUT_NO_SHEET_SPEC:
    'У части деталей материал без раскройной спецификации (размеров листа). Задайте спецификацию материала в Конфигурации и повторите расчёт.',
  CUT_REQUEST_TOO_LARGE:
    'Слишком много деталей в одном раскрое для оптимизатора. Разбейте задание на несколько меньших.',
  CUT_MAX_INSTANCES_EXCEEDED:
    'Слишком много деталей (с учётом количества) для одного раскроя. Разбейте задание на несколько меньших.',
  CUT_INVALID_GRAIN_RULE:
    'Некорректная настройка направления текстуры (grain) в конфигурации раскроя. Проверьте параметры раскроя.',
  CUT_SHEET_MATERIAL_NOT_CUTTABLE:
    'Выбранный лист материала неактивен или не допускает раскрой. Выберите другой лист и повторите расчёт.',
};

/** Read a string `code` off an unknown error without assuming its type. */
function extractCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

/**
 * Best-effort HTTP status for the re-thrown ApiError. Duck-typed: real freecut
 * errors are ApiError (`statusCode`), but the repository port accepts any
 * optimize impl, and some callers/tests carry a plain `status`. Falls back 500.
 */
export function extractCutFailureStatus(error: unknown): number {
  if (error instanceof ApiError) return error.statusCode;
  if (error && typeof error === 'object') {
    const e = error as { statusCode?: unknown; status?: unknown };
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (typeof e.status === 'number') return e.status;
  }
  return 500;
}

/**
 * Whether this error should mark the cut job failed (and persist a reason). True
 * for any genuine calculation failure; false for precondition/concurrency
 * rejections that the client simply retries with a fresh version.
 */
export function shouldMarkCutFailed(error: unknown): boolean {
  const code = extractCode(error);
  return code === null || !PASSTHROUGH_CODES.has(code);
}

/**
 * Map any cut-calculation failure to a persisted code + operator reason. Never
 * throws: an unknown or malformed error degrades to the generic fallback.
 */
export function describeCutFailure(error: unknown): CutFailureInfo {
  const code = extractCode(error);
  if (code && REASON_BY_CODE[code]) {
    return { code, reason: REASON_BY_CODE[code] };
  }
  return { code: CUT_FAILURE_FALLBACK_CODE, reason: FALLBACK_REASON };
}
