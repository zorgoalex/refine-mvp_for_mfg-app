import { clientScreenOrderPath } from './clientScreenOrderKeys';

/**
 * What ends a presentation from outside the order screen. A presentation may go on after its order
 * screen was unloaded (the customer keeps the order), so nothing here relies on that screen:
 *  - the session ends or the user changes → the presentation ends and everything kept is erased;
 *  - the same user gets other permissions → it ends (what was read under the old ones is not kept);
 *  - the workspace tab of the presented order is closed → it ends.
 */
export interface ClientScreenLifecycleDeps {
  /** Called before the session is cleared or the identity changes. */
  subscribeSessionEnd(listener: () => void): () => void;
  /** Called on any change of the session (token, user, permissions). */
  subscribeSession(listener: () => void): () => void;
  /** Who is logged in and with which permissions, as one comparable string. */
  actorKey(): string;
  /** Called with the keys of the open workspace tabs, now and before the change. */
  subscribeTabs(listener: (keys: readonly string[], previous: readonly string[]) => void): () => void;
}

export function connectClientScreenLifecycle(
  presenter: { hide(): void; getView(): { presentedOrderKey: string | null } },
  deps: ClientScreenLifecycleDeps,
): () => void {
  let actor = deps.actorKey();
  const stops = [
    deps.subscribeSessionEnd(() => {
      presenter.hide();
      actor = '';
    }),
    deps.subscribeSession(() => {
      const next = deps.actorKey();
      if (next === actor) return;
      actor = next;
      presenter.hide();
    }),
    deps.subscribeTabs((keys, previous) => {
      const orderKey = presenter.getView().presentedOrderKey;
      if (orderKey === null) return;
      const path = clientScreenOrderPath(orderKey);
      // Only a tab that was open and is not any more: a screen shown without a workspace tab is not judged here.
      if (previous.includes(path) && !keys.includes(path)) presenter.hide();
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

/** Identity and permissions of the user as one string. */
export function clientScreenActorKey(user: { id?: unknown; permissions?: readonly string[] | null } | null | undefined): string {
  if (!user) return '';
  return `${String(user.id ?? '')}|${[...(user.permissions ?? [])].sort().join(',')}`;
}
