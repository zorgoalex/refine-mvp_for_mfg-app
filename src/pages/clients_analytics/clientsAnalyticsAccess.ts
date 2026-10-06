// Who may open the clients dashboard and the client card. Mirrors the backend rule
// (ClientsAnalyticsService): five rights and an unlimited view of orders and payments, plus a backend
// session — the screen then offers the dashboard and the card only to a user the backend will answer.
import type { PermissionName } from '../../api/types/authApi.types';

export const CLIENTS_ANALYTICS_PERMISSIONS: readonly PermissionName[] = [
  'clients.analytics.view',
  'clients.view',
  'orders.view',
  'orders.view_financials',
  'payments.view',
];

export interface ClientsAnalyticsUser {
  permissions?: readonly string[] | null;
  policyScopes?: { orders?: { view?: string }; payments?: { view?: string } } | null;
}

export type ClientsAnalyticsAccess = 'allowed' | 'legacy_login' | 'no_permission' | 'limited_scope';

export function clientsAnalyticsAccess(
  user: ClientsAnalyticsUser | null | undefined,
  flags: { useBackendAuth: boolean; useBackendPermissions: boolean },
): ClientsAnalyticsAccess {
  if (!flags.useBackendAuth || !flags.useBackendPermissions) return 'legacy_login';
  const permissions = user?.permissions ?? [];
  if (!CLIENTS_ANALYTICS_PERMISSIONS.every((permission) => permissions.includes(permission))) return 'no_permission';
  return user?.policyScopes?.orders?.view === 'all' && user?.policyScopes?.payments?.view === 'all' ? 'allowed' : 'limited_scope';
}

export const CLIENTS_ANALYTICS_ACCESS_TEXT: Record<Exclude<ClientsAnalyticsAccess, 'allowed'>, string> = {
  legacy_login: 'Дашборд и карточка клиента недоступны в этом режиме входа.',
  no_permission: 'Дашборд и карточка клиента доступны с правами на аналитику клиентов, заказы с суммами и платежи.',
  limited_scope: 'Дашборд и карточка клиента показывают заказы и платежи всех менеджеров и доступны только при полной видимости заказов и платежей.',
};
