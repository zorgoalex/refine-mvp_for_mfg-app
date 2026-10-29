/**
 * Keys of presentation sources. The edit form presents under the order key of its draft (the order
 * id, or 'new'); the view page of the same order is another source and has its own key.
 */
const VIEW_PREFIX = 'view:';

export const orderShowPresentationKey = (orderId: number | string): string => `${VIEW_PREFIX}${orderId}`;

/**
 * What happens to a presentation when the screen of its order unmounts. While the order's workspace
 * tab is still open the app has only unloaded an inactive tab: the customer keeps the order. When the
 * tab is gone the manager closed the order: the presentation ends.
 */
export function clientScreenUnmountAction(orderKey: string, openTabKeys: readonly string[]): 'keep' | 'end' {
  return openTabKeys.includes(clientScreenOrderPath(orderKey)) ? 'keep' : 'end';
}

/** The page of the app (and the key of its workspace tab) that presents under this key. */
export function clientScreenOrderPath(orderKey: string): string {
  if (orderKey.startsWith(VIEW_PREFIX)) return `/orders/show/${orderKey.slice(VIEW_PREFIX.length)}`;
  return orderKey === 'new' ? '/orders/create' : `/orders/edit/${orderKey}`;
}
