/** Расчёты быстрого платежа NewLine на телефоне (мокап 22, нижний лист «Добавить платёж»). */

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const quickPaymentMoney = (value: number): string =>
  `${round2(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, ' ')} ₸`;

/** Остаток заказа по тем же полям, что шапка карточки: итог (или сумма) минус оплачено, не меньше нуля. */
export function quickPaymentRemaining(record: Record<string, unknown> | null | undefined): number {
  const total = Number(record?.total_amount) || 0;
  // итог 0 (полная скидка) — настоящий ноль, а не «нет итога»: к сумме заказа откатываемся только без итога
  const rawFinal = record?.final_amount;
  const finalNumber = rawFinal == null || rawFinal === '' ? Number.NaN : Number(rawFinal);
  const final = Number.isFinite(finalNumber) ? finalNumber : total;
  const paid = Number(record?.paid_amount) || 0;
  return Math.max(0, round2(final - paid));
}

export interface QuickPaymentPreset {
  key: 'all' | 'half';
  label: string;
  amount: number;
}

/** «Весь остаток» и «Половина»; без остатка — ничего. */
export function quickPaymentPresets(remaining: number): QuickPaymentPreset[] {
  if (!(remaining > 0)) return [];
  const presets: QuickPaymentPreset[] = [{ key: 'all', label: 'Весь остаток', amount: round2(remaining) }];
  const half = round2(remaining / 2);
  if (half > 0 && half !== round2(remaining)) presets.push({ key: 'half', label: 'Половина', amount: half });
  return presets;
}

export interface QuickPaymentNotice {
  tone: 'ok' | 'warn' | 'info';
  text: string;
}

/** Что станет с заказом после платежа; null, пока сумма не введена. */
export function quickPaymentNotice(remaining: number, amount: number | null | undefined): QuickPaymentNotice | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  const left = round2(remaining - amount);
  if (left === 0) return { tone: 'ok', text: 'После платежа заказ будет оплачен полностью' };
  if (left > 0) return { tone: 'info', text: `После платежа останется ${quickPaymentMoney(left)}` };
  return { tone: 'warn', text: `Сумма больше остатка на ${quickPaymentMoney(-left)} — будет переплата` };
}

/** Сумма годится для POST /payments: положительная, не больше двух знаков после запятой. */
export function isValidQuickPaymentAmount(amount: number | null | undefined): amount is number {
  return amount != null && Number.isFinite(amount) && amount > 0 && round2(amount) === amount;
}

/**
 * Исход неудачной записи. `rejected` — сервер ответил 4xx: платёж точно не записан, можно поправить и
 * отправить снова. `uncertain` — нет ответа, таймаут или 5xx: платёж мог записаться, повтор вслепую
 * создаст второй (у API нет ключа идемпотентности).
 */
export function classifyQuickPaymentError(error: unknown): 'rejected' | 'uncertain' {
  const raw = error as { statusCode?: unknown; status?: unknown } | null | undefined;
  const status = Number(raw?.statusCode ?? raw?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'uncertain';
}

/**
 * Состояние листа. Любая попытка записи (успех, отказ, неясный исход) переводит лист в `syncing`: новая
 * отправка закрыта, пока заказ не перечитан успешно; закрыть и открыть лист это не снимает.
 *   idle/review → submitting → syncing(after) → idle (успех: предзаполнить свежим остатком; отказ: сумма прежняя)
 *                                              | review (неясный исход: быстрый лист закрыт до перезагрузки страницы —
 *                                                 у POST платежа нет ключа идемпотентности, и перечитанный заказ не
 *                                                 доказывает, что первый запрос уже не запишется; проверять и добавлять —
 *                                                 в полной форме платежей)
 *                                              | stale (не перечитан: отправка закрыта, «Проверить ещё раз»)
 *   stale → syncing (повторная проверка, в том числе при открытии листа)
 */
export type QuickPaymentPhase = 'idle' | 'submitting' | 'syncing' | 'stale' | 'review';
export type QuickPaymentOutcome = 'success' | 'rejected' | 'uncertain';

export interface QuickPaymentState {
  phase: QuickPaymentPhase;
  /** Исход последней попытки, пока заказ не перечитан. */
  after: QuickPaymentOutcome | null;
  amount: number | null;
  /** Предзаполнить сумму свежим остатком, когда лист открыт и свободен. */
  prefillPending: boolean;
}

export const initialQuickPaymentState: QuickPaymentState = { phase: 'idle', after: null, amount: null, prefillPending: true };

/** Состояние нового листа по незакрытой попытке этого заказа (она переживает размонтирование листа). */
export function quickPaymentStateFromAttempt(
  attempt: { status: 'inflight' } | { status: 'settled'; outcome: QuickPaymentOutcome } | { status: 'review' } | null,
): QuickPaymentState {
  if (!attempt) return initialQuickPaymentState;
  if (attempt.status === 'inflight') return { phase: 'submitting', after: null, amount: null, prefillPending: false };
  if (attempt.status === 'settled') return { phase: 'syncing', after: attempt.outcome, amount: null, prefillPending: false };
  return { phase: 'review', after: null, amount: null, prefillPending: false };
}

export type QuickPaymentEvent =
  | { type: 'open' }
  | { type: 'prefill'; amount: number | null }
  | { type: 'setAmount'; amount: number | null }
  | { type: 'submit' }
  | { type: 'settled'; outcome: QuickPaymentOutcome }
  | { type: 'synced'; ok: boolean }
  | { type: 'recheck' };

export function quickPaymentReducer(state: QuickPaymentState, event: QuickPaymentEvent): QuickPaymentState {
  switch (event.type) {
    case 'open':
      return state.phase === 'idle' ? { ...state, prefillPending: true } : state;
    case 'prefill':
      return state.phase === 'idle' && state.prefillPending ? { ...state, amount: event.amount, prefillPending: false } : state;
    case 'setAmount':
      return state.phase === 'idle' ? { ...state, amount: event.amount, prefillPending: false } : state;
    case 'submit':
      return state.phase === 'idle' ? { ...state, phase: 'submitting' } : state;
    case 'settled':
      if (state.phase !== 'submitting') return state;
      return {
        ...state,
        phase: 'syncing',
        after: event.outcome,
        amount: event.outcome === 'rejected' ? state.amount : null,
        prefillPending: false,
      };
    case 'synced':
      if (state.phase !== 'syncing') return state;
      if (!event.ok) return { ...state, phase: 'stale' };
      if (state.after === 'uncertain') return { ...state, phase: 'review', after: null, amount: null, prefillPending: false };
      return { ...state, phase: 'idle', after: null, prefillPending: state.after === 'success' };
    case 'recheck':
      return state.phase === 'stale' ? { ...state, phase: 'syncing' } : state;
    default:
      return state;
  }
}

/** Отправлять можно только из idle, с корректной суммой и способом из текущего списка активных. */
export function canSubmitQuickPayment(input: {
  phase: QuickPaymentPhase;
  amount: number | null | undefined;
  typePaidId: number | null;
  activeTypeIds: readonly number[];
  dateValid: boolean;
}): boolean {
  return (
    input.phase === 'idle' &&
    isValidQuickPaymentAmount(input.amount) &&
    input.typePaidId != null &&
    input.activeTypeIds.includes(input.typePaidId) &&
    input.dateValid
  );
}

/** Выбор способа: сохранённый, если он ещё активен, иначе первый активный; null без активных. */
export function resolveQuickPaymentType(
  current: number | null,
  remembered: number | null,
  activeTypeIds: readonly number[],
): number | null {
  if (current != null && activeTypeIds.includes(current)) return current;
  if (remembered != null && activeTypeIds.includes(remembered)) return remembered;
  return activeTypeIds[0] ?? null;
}
