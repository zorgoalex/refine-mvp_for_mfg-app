import { ApiError } from '../../api/apiError';
import type { ClientPaymentsResponse } from '../../api/clientsReadApi';
import { clientOrderMoney } from './clientOrdersModel';

/** Права вкладки «Платежи» — те же, что проверяет backend (видимость заказов и платежей он применяет сам). */
export const CLIENT_PAYMENTS_PERMISSIONS = ['clients.view', 'orders.view', 'payments.view', 'orders.view_financials'] as const;
export type ClientPaymentsPermission = (typeof CLIENT_PAYMENTS_PERMISSIONS)[number];

/** Вкладка «Платежи» показывается только при всех её правах. */
export function canSeeClientPayments(can: (permission: ClientPaymentsPermission) => boolean): boolean {
  return CLIENT_PAYMENTS_PERMISSIONS.every((permission) => can(permission));
}

/** Итог вкладки «Платежи» по всем страницам: число платежей и их сумма. */
export function clientPaymentsTotals(response: Pick<ClientPaymentsResponse, 'pagination' | 'summary'>): Array<{ label: string; value: string }> {
  return [
    { label: 'Платежей', value: String(response.pagination.total) },
    { label: 'Сумма', value: clientOrderMoney(response.summary.amount) },
  ];
}

/** Пояснение над списком, когда пользователь видит платежи не всех заказов клиента. */
export function clientPaymentsScopeNote(scope: ClientPaymentsResponse['scope']): string | null {
  if (scope === 'own') return 'Показаны только платежи по вашим заказам этого клиента; итог — по ним.';
  if (scope === 'restricted') return 'Показаны только платежи по заказам этого клиента, к которым у вас есть доступ; итог — по ним.';
  return null;
}

/** Почему список не показан: нет прав, старый backend без этого чтения или сбой. */
export function clientPaymentsProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Недостаточно прав для просмотра платежей клиента.';
  if (error instanceof ApiError && error.status === 404 && error.code !== 'CLIENT_NOT_FOUND') return 'Список платежей клиента появится после обновления сервера.';
  return 'Не удалось загрузить платежи клиента. Обновите страницу.';
}
