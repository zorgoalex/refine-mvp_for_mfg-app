import { describe, expect, it, vi } from 'vitest';
import { clientScreenActorKey, connectClientScreenLifecycle } from './clientScreenLifecycle';

function setup(presentedOrderKey: string | null = '7') {
  const view = { presentedOrderKey };
  const presenter = { hide: vi.fn(() => { view.presentedOrderKey = null; }), getView: () => view };
  const sessionEnd = new Set<() => void>();
  const session = new Set<() => void>();
  const tabs = new Set<(keys: readonly string[], previous: readonly string[]) => void>();
  const actor = { current: clientScreenActorKey({ id: 1, permissions: ['orders.view', 'clients.view'] }) };
  const add = <T,>(set: Set<T>) => (listener: T) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const stop = connectClientScreenLifecycle(presenter, {
    subscribeSessionEnd: add(sessionEnd), subscribeSession: add(session), actorKey: () => actor.current, subscribeTabs: add(tabs),
  });
  return { presenter, view, actor, stop, fire: {
    sessionEnd: () => sessionEnd.forEach((listener) => listener()),
    session: () => session.forEach((listener) => listener()),
    tabs: (keys: string[], previous: string[]) => tabs.forEach((listener) => listener(keys, previous)),
  } };
}

describe('what ends a presentation from outside the order screen', () => {
  it('logout or another user: the presentation ends', () => {
    const { presenter, fire } = setup();
    fire.sessionEnd();
    expect(presenter.hide).toHaveBeenCalledTimes(1);
  });

  it('the same user with other permissions: it ends; a token refresh with the same permissions does not touch it', () => {
    const { presenter, actor, fire } = setup();
    fire.session();
    expect(presenter.hide).not.toHaveBeenCalled();
    actor.current = clientScreenActorKey({ id: 1, permissions: ['orders.view'] });
    fire.session();
    expect(presenter.hide).toHaveBeenCalledTimes(1);
    fire.session();
    expect(presenter.hide).toHaveBeenCalledTimes(1);
  });

  it('the order of permissions does not matter; the user does', () => {
    expect(clientScreenActorKey({ id: 1, permissions: ['b', 'a'] })).toBe(clientScreenActorKey({ id: 1, permissions: ['a', 'b'] }));
    expect(clientScreenActorKey({ id: 2, permissions: ['a', 'b'] })).not.toBe(clientScreenActorKey({ id: 1, permissions: ['a', 'b'] }));
    expect(clientScreenActorKey(null)).toBe('');
  });

  it('the workspace tab of the presented order is closed — also long after its screen was unloaded: it ends', () => {
    const { presenter, fire } = setup('7');
    // Other tabs come and go, the order's tab stays (its screen may be unloaded meanwhile).
    fire.tabs(['/orders', '/orders/edit/7', '/orders/edit/8'], ['/orders', '/orders/edit/7']);
    fire.tabs(['/orders', '/orders/edit/7'], ['/orders', '/orders/edit/7', '/orders/edit/8']);
    expect(presenter.hide).not.toHaveBeenCalled();
    fire.tabs(['/orders'], ['/orders', '/orders/edit/7']);
    expect(presenter.hide).toHaveBeenCalledTimes(1);
  });

  it('the view page has its own tab; a screen shown without a workspace tab is not judged; nothing presented — nothing happens', () => {
    const view = setup('view:7');
    view.fire.tabs(['/orders/show/7'], ['/orders/show/7', '/orders/edit/7']);
    expect(view.presenter.hide).not.toHaveBeenCalled();
    view.fire.tabs([], ['/orders/show/7']);
    expect(view.presenter.hide).toHaveBeenCalledTimes(1);
    const noTab = setup('7');
    noTab.fire.tabs(['/orders'], []);
    expect(noTab.presenter.hide).not.toHaveBeenCalled();
    const idle = setup(null);
    idle.fire.tabs([], ['/orders/edit/7']);
    idle.fire.sessionEnd();
    expect(idle.presenter.hide).toHaveBeenCalledTimes(1);
  });

  it('after disconnecting nothing is listened to', () => {
    const { presenter, stop, fire } = setup();
    stop();
    fire.sessionEnd();
    fire.tabs([], ['/orders/edit/7']);
    expect(presenter.hide).not.toHaveBeenCalled();
  });
});
