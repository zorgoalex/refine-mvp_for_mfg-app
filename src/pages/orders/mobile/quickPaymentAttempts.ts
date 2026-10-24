/**
 * Попытки быстрого платежа по заказам — вне компонентов, на всё время жизни страницы.
 * Лист и карточка заказа могут размонтироваться посреди записи (закрыли вкладку рабочего пространства,
 * сменилась ширина экрана); запрос при этом продолжается, а его исход должен дождаться следующего листа
 * этого заказа: пока заказ не перечитан успешно, новая отправка закрыта.
 */
import { classifyQuickPaymentError, type QuickPaymentOutcome } from './workbenchQuickPaymentModel';

export type QuickPaymentAttempt =
  | { status: 'inflight' }
  /** Запрос завершился, заказ ещё не перечитан. */
  | { status: 'settled'; outcome: QuickPaymentOutcome }
  /**
   * Неясный исход, заказ перечитан. Быстрая отправка этого заказа закрыта до перезагрузки страницы: у создания
   * платежа нет ключа идемпотентности, и первый запрос может записаться уже после перечитывания.
   */
  | { status: 'review' };

const attempts = new Map<number, QuickPaymentAttempt>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function getQuickPaymentAttempt(orderId: number): QuickPaymentAttempt | null {
  return attempts.get(orderId) ?? null;
}

export function subscribeQuickPaymentAttempts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Запускает запись; исход сохраняется, даже если вызвавший лист уже размонтирован.
 * Повторный запуск, пока прошлая попытка не перечитана или после неясного исхода (review), отклоняется (null).
 */
export function runQuickPaymentAttempt(
  orderId: number,
  create: () => Promise<unknown>,
  /** Сразу после завершения запроса, при любом исходе и без смонтированного листа: обновить кэши списков. */
  afterSettled?: () => void,
): Promise<{ outcome: QuickPaymentOutcome; error?: unknown }> | null {
  const current = attempts.get(orderId);
  if (current) return null;
  attempts.set(orderId, { status: 'inflight' });
  notify();
  const settle = (outcome: QuickPaymentOutcome) => {
    attempts.set(orderId, { status: 'settled', outcome });
    try {
      afterSettled?.();
    } catch {
      // обновление кэшей — не повод потерять исход попытки
    }
    notify();
  };
  return create().then(
    () => {
      settle('success');
      return { outcome: 'success' as const };
    },
    (error: unknown) => {
      const outcome = classifyQuickPaymentError(error);
      settle(outcome);
      return { outcome, error };
    },
  );
}

/** Заказ перечитан после попытки: успех/отказ — попытка закрыта; неясный исход — быстрая отправка закрыта (review). */
export function markQuickPaymentReconciled(orderId: number): void {
  const current = attempts.get(orderId);
  if (current?.status !== 'settled') return;
  if (current.outcome === 'uncertain') attempts.set(orderId, { status: 'review' });
  else attempts.delete(orderId);
  notify();
}

/** Только для тестов. */
export function resetQuickPaymentAttemptsForTests(): void {
  attempts.clear();
  notify();
}
