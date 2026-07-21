import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '../../stores/tabStore';
import { requestEvolutionTabClose } from './EvolutionWorkspaceTabs';

const tabs: WorkspaceTab[] = [
  { key: '/orders', path: '/orders', label: 'Заказы', resource: 'orders_view', dirty: false },
  { key: '/orders/create', path: '/orders/create?from=list', label: 'Новый заказ', resource: 'orders_view', dirty: true },
  { key: '/calendar', path: '/calendar', label: 'Календарь', resource: 'calendar', dirty: false },
];

describe('evolution workspace tab close interaction', () => {
  it('closes a clean active tab immediately and navigates to its neighbor', () => {
    const closeTab = vi.fn();
    const navigate = vi.fn();
    const confirmDiscard = vi.fn();

    requestEvolutionTabClose({
      targetKey: '/orders',
      activeKey: '/orders',
      tabs,
      closeTab,
      navigate,
      confirmDiscard,
    });

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith('/orders', undefined);
    expect(navigate).toHaveBeenCalledWith('/orders/create?from=list');
  });

  it('keeps a dirty tab open until confirmation then discards its draft', () => {
    const closeTab = vi.fn();
    const navigate = vi.fn();
    let confirm: (() => void) | undefined;

    requestEvolutionTabClose({
      targetKey: '/orders/create',
      activeKey: '/orders/create',
      tabs,
      closeTab,
      navigate,
      confirmDiscard: (onConfirm) => {
        confirm = onConfirm;
      },
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    confirm?.();

    expect(closeTab).toHaveBeenCalledWith('/orders/create', { discard: true });
    expect(navigate).toHaveBeenCalledWith('/calendar');
  });
});

