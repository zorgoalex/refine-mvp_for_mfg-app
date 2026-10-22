import type { CurrentUser } from '../../permissions/current-user';
import { appendOrderReadVisibilitySql, orderReadVisibilityIsRestricted } from '../../permissions/policies/order-read-scope-sql';

/**
 * Which ERP orders of a client are read: none, or the ones the viewer may read — all of them or only the viewer's
 * own (creator or manager). The SQL of the rule is the shared order read visibility, built from `viewer` by the
 * repositories.
 */
export type ClientOrderReadScope = { kind: 'all'; viewer: CurrentUser } | { kind: 'own'; viewer: CurrentUser } | { kind: 'none' };

/**
 * Which ERP orders of a client the user may be told about: nothing without `orders.view`; otherwise the shared order
 * read visibility (the same rule as the orders list and the order card) — only the user's own orders when the
 * visibility is restricted to «own», all orders when it is not restricted, nothing without any grant.
 */
export function clientOrderReadScope(user: CurrentUser): ClientOrderReadScope {
  if (!user.permissions.includes('orders.view')) return { kind: 'none' };
  if (!orderReadVisibilityIsRestricted(user)) return { kind: 'all', viewer: user };
  // Restricted: either the «own» predicate or no grant at all (`FALSE`).
  return appendOrderReadVisibilitySql([], user) === 'FALSE' ? { kind: 'none' } : { kind: 'own', viewer: user };
}
