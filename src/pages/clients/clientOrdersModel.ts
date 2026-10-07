import { ApiError } from '../../api/apiError';
import type { ClientOrder, ClientOrdersResponse } from '../../api/clientsReadApi';

/** «12 500,00» — деньги заказа; пусто, если backend сумму не отдал (нет права видеть финансы). */
export function clientOrderMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Номер заказа с кодом проекта, как в списке заказов; иначе название; иначе id. */
export function clientOrderNumber(order: Pick<ClientOrder, 'fullNumber' | 'orderName' | 'orderId'>): string {
  return order.fullNumber?.trim() || order.orderName?.trim() || `#${order.orderId}`;
}

/**
 * Итог вкладки «Документы ERP» по всем заказам клиента, видимым пользователю (все страницы): число заказов и —
 * если backend отдал деньги (право видеть финансы) — сумма, оплачено и долг.
 */
export function clientOrdersTotals(response: Pick<ClientOrdersResponse, 'pagination' | 'summary'>): Array<{ label: string; value: string }> {
  const items = [{ label: 'Заказов', value: String(response.pagination.total) }];
  if (!response.summary) return items;
  return [...items,
    { label: 'Сумма', value: clientOrderMoney(response.summary.finalAmount) },
    { label: 'Оплачено', value: clientOrderMoney(response.summary.paidAmount) },
    { label: 'Долг', value: clientOrderMoney(response.summary.debtAmount) }];
}

/** Пояснение над списком: пользователь с доступом «только свои» видит не все заказы клиента. */
export function clientOrdersScopeNote(scope: ClientOrdersResponse['scope']): string | null {
  return scope === 'own' ? 'Показаны только ваши заказы этого клиента (вы автор или менеджер заказа); итог — по ним.' : null;
}

/** Почему список не показан: нет прав, старый backend без этого чтения или сбой. */
export function clientOrdersProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Недостаточно прав для просмотра заказов клиента.';
  if (error instanceof ApiError && error.status === 404 && error.code !== 'CLIENT_NOT_FOUND') return 'Список заказов клиента появится после обновления сервера.';
  return 'Не удалось загрузить заказы клиента. Обновите страницу.';
}
