import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type {
  MdfPublishedCard,
  MdfPublishedSnapshot,
  MdfSessionSnapshot,
  MdfSourceKind,
} from '../../api/types/mdfPublishedApi.types';

vi.mock('antd', () => ({
  Badge: 'mock-badge',
  Dropdown: 'mock-dropdown',
  Empty: 'mock-empty',
  Select: 'mock-select',
  Tag: 'mock-tag',
  Tooltip: 'mock-tooltip',
  Typography: { Text: 'mock-text', Title: 'mock-title' },
}));
// The view takes Tooltip from the app's delayed wrapper (tooltipDelay guard), not from antd.
vi.mock('../../ui/tooltipDelay', () => ({ Tooltip: 'mock-tooltip' }));
vi.mock('@ant-design/icons', () => ({
  SearchOutlined: 'mock-search-icon',
  WarningOutlined: 'mock-warning-icon',
}));

import { MdfPublishedBoardView, type MdfPublishedBoardViewProps } from './MdfPublishedBoardView';

const READY_TOKEN = 'a'.repeat(64);

function card(overrides: Partial<MdfPublishedCard> = {}): MdfPublishedCard {
  const id = overrides.id ?? 'card-1';
  return {
    kind: 'packet',
    id,
    displayName: `Карточка ${id}`,
    column: 'completed',
    sourceCreatedAt: '2026-09-27T00:00:00.000Z',
    acceptedRevision: 'rev-1',
    receivedRevision: 'rev-1',
    commandToken: READY_TOKEN,
    issues: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<MdfPublishedSnapshot> = {}): MdfPublishedSnapshot {
  return {
    schemaVersion: 1,
    mode: 'active',
    revision: 'rev-1',
    generatedAt: '2026-09-27T00:00:00.000Z',
    dateFrom: '2026-07-27',
    dateTo: '2026-09-27',
    cards: [card()],
    members: [],
    positions: [],
    pendingJobs: [],
    trackedJobs: [],
    presentation: [],
    progress: [],
    orders: [],
    unregistered: [],
    issues: [],
    ...overrides,
  };
}

function session(overrides: Partial<MdfPublishedSnapshot> = {}): MdfSessionSnapshot {
  return { sessionGeneration: 1, snapshot: snapshot(overrides) };
}

const baseProps: Omit<MdfPublishedBoardViewProps, 'session'> = {
  workday: '2026-09-27',
  period: '1d',
  orderFilters: [],
  searchText: '',
  searchOrderIds: [],
  focusKind: null,
  focusId: null,
  searchResolving: false,
  canMove: true,
  onRequestSearchOrderNames: vi.fn(),
  onMove: vi.fn(),
  onFocusCard: vi.fn(),
};

function findCard(view: ReactTestRenderer, kind: MdfSourceKind, id: string) {
  return view.root.findAll((node) => node.props['data-mdf-published-card'] === `${kind}:${id}`);
}

/** Flattens a test instance's rendered subtree to its concatenated text content by walking
 * `.children` (a mix of nested `ReactTestInstance`s and raw strings) — adjacent JSX text/number
 * expressions are separate children (e.g. `6/10` is the children `[6, "/", 10]`), so a naive
 * `JSON.stringify` would never contain it as a contiguous substring. */
function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string | number): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    for (const child of node.children) walk(child as ReactTestInstance | string | number);
  };
  walk(instance);
  return parts.join('');
}

describe('MdfPublishedBoardView: §5.8/D2 — no client-side period re-filter (the backend display cut is the only filter)', () => {
  it('keeps a March card visible for a September search (order in the active searchOrderIds)', () => {
    const marchCard = card({ id: 'march-card', sourceCreatedAt: '2026-03-10T00:00:00.000Z' });
    const septCard = card({ id: 'sept-card', sourceCreatedAt: '2026-09-27T00:00:00.000Z' });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          searchOrderIds={[55]}
          session={session({
            cards: [septCard, marchCard],
            orders: [{ orderId: 55, orderName: 'Заказ 55' }],
            members: [{ kind: 'packet', id: 'march-card', orderId: 55, detailId: 500, quantity: 2 }],
          })}
        />,
      );
    });
    expect(findCard(view, 'packet', 'march-card')).toHaveLength(1);
    expect(findCard(view, 'packet', 'sept-card')).toHaveLength(1);
  });

  // D2: a card out of any conventional date window (e.g. March, searched from September) is no longer removed
  // client-side even OUTSIDE an active search/focus — the backend's own display cut already decided what belongs
  // in `session.snapshot.cards`; the view renders that set as-is (`filterMdfPublishedCardsByPeriod` is gone).
  it('never removes a card by date — the backend display cut is the only filter, search/focus notwithstanding', () => {
    const marchCard = card({ id: 'march-card', sourceCreatedAt: '2026-03-10T00:00:00.000Z' });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          searchOrderIds={[]}
          session={session({ cards: [marchCard] })}
        />,
      );
    });
    expect(findCard(view, 'packet', 'march-card')).toHaveLength(1);
  });

  it('keeps the focused card visible even outside the window and outside the search', () => {
    const marchCard = card({ id: 'march-card', sourceCreatedAt: '2026-03-10T00:00:00.000Z' });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          focusKind="packet"
          focusId="march-card"
          session={session({ cards: [marchCard] })}
        />,
      );
    });
    expect(findCard(view, 'packet', 'march-card')).toHaveLength(1);
  });

  it('always renders the search control, including on a completely empty board', () => {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          session={session({ cards: [] })}
        />,
      );
    });
    // The search Select control is present...
    expect(view.root.findAllByType('mock-select' as never)).toHaveLength(1);
    // ...even though the board has no cards to show.
    expect(view.root.findAllByType('mock-empty' as never)).toHaveLength(1);
  });
});

describe('MdfPublishedBoardView: §5.6 R2#2 — search control propagates the current selection, including clearing', () => {
  it('calls onSearch with the CURRENT selection unconditionally — even when it is empty (cleared/removed)', () => {
    const onRequestSearchOrderNames = vi.fn();
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          onRequestSearchOrderNames={onRequestSearchOrderNames}
          session={session()}
        />,
      );
    });
    const select = view.root.findByType('mock-select' as never);
    act(() => { select.props.onChange(['Заказ 10', 'Заказ 20']); });
    expect(onRequestSearchOrderNames).toHaveBeenLastCalledWith(['Заказ 10', 'Заказ 20']);
    act(() => { select.props.onChange(['Заказ 10']); });
    expect(onRequestSearchOrderNames).toHaveBeenLastCalledWith(['Заказ 10']);
    act(() => { select.props.onChange([]); });
    // The bug: an empty selection was never propagated, so the caller (hook) could never clear
    // searchOrderIds again once something had been searched.
    expect(onRequestSearchOrderNames).toHaveBeenLastCalledWith([]);
    expect(onRequestSearchOrderNames).toHaveBeenCalledTimes(3);
  });

  // D2: removing (or clearing) searchOrderIds no longer drops a card by date — there is no period-exemption
  // mechanism left to fall out of. Both march cards stay visible regardless of the search selection, since the
  // backend's own display cut (not the client) already decided they belong in `session.snapshot.cards`.
  it('removing one previously-searched order from searchOrderIds does not drop its card (no exemption to lose)', () => {
    const marchA = card({ id: 'march-a', sourceCreatedAt: '2026-03-01T00:00:00.000Z' });
    const marchB = card({ id: 'march-b', sourceCreatedAt: '2026-03-02T00:00:00.000Z' });
    const props = {
      ...baseProps,
      session: session({
        cards: [marchA, marchB],
        orders: [{ orderId: 55, orderName: 'Заказ 55' }, { orderId: 66, orderName: 'Заказ 66' }],
        members: [
          { kind: 'packet' as const, id: 'march-a', orderId: 55, detailId: 500, quantity: 1 },
          { kind: 'packet' as const, id: 'march-b', orderId: 66, detailId: 600, quantity: 1 },
        ],
      }),
    };
    let view!: ReactTestRenderer;
    act(() => { view = create(<MdfPublishedBoardView {...props} searchOrderIds={[55, 66]} />); });
    expect(findCard(view, 'packet', 'march-a')).toHaveLength(1);
    expect(findCard(view, 'packet', 'march-b')).toHaveLength(1);

    // Simulate the hook dropping order 66 from searchOrderIds after its tag was removed.
    act(() => { view.update(<MdfPublishedBoardView {...props} searchOrderIds={[55]} />); });
    expect(findCard(view, 'packet', 'march-a')).toHaveLength(1);
    expect(findCard(view, 'packet', 'march-b')).toHaveLength(1);
  });

  it('clearing searchOrderIds entirely does not drop any previously-searched card (no exemption to lose)', () => {
    const marchA = card({ id: 'march-a', sourceCreatedAt: '2026-03-01T00:00:00.000Z' });
    const marchB = card({ id: 'march-b', sourceCreatedAt: '2026-03-02T00:00:00.000Z' });
    const props = {
      ...baseProps,
      session: session({
        cards: [marchA, marchB],
        orders: [{ orderId: 55, orderName: 'Заказ 55' }, { orderId: 66, orderName: 'Заказ 66' }],
        members: [
          { kind: 'packet' as const, id: 'march-a', orderId: 55, detailId: 500, quantity: 1 },
          { kind: 'packet' as const, id: 'march-b', orderId: 66, detailId: 600, quantity: 1 },
        ],
      }),
    };
    let view!: ReactTestRenderer;
    act(() => { view = create(<MdfPublishedBoardView {...props} searchOrderIds={[55, 66]} />); });
    expect(findCard(view, 'packet', 'march-a')).toHaveLength(1);
    expect(findCard(view, 'packet', 'march-b')).toHaveLength(1);

    act(() => { view.update(<MdfPublishedBoardView {...props} searchOrderIds={[]} />); });
    expect(findCard(view, 'packet', 'march-a')).toHaveLength(1);
    expect(findCard(view, 'packet', 'march-b')).toHaveLength(1);
  });
});

describe('MdfPublishedBoardView: §5.6 finding 8 — members/progress always render', () => {
  it('shows members + progress for a stale (minimal) card, in addition to the warning', () => {
    const staleCard = card({ id: 'stale-1' });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          session={session({
            cards: [staleCard],
            orders: [{ orderId: 10, orderName: 'Заказ 10' }],
            members: [{ kind: 'packet', id: 'stale-1', orderId: 10, detailId: 100, quantity: 6 }],
            progress: [{ kind: 'packet', id: 'stale-1', orderId: 10, detailId: 100, member: 6, cut: 3, laminated: 0 }],
            presentation: [{ kind: 'packet', id: 'stale-1', stale: true, composition: null, live: null }],
          })}
        />,
      );
    });
    const members = view.root.findAllByProps({ className: 'mdf-published-card__members' });
    expect(members).toHaveLength(1);
    const text = textOf(members[0]!);
    expect(text).toContain('Заказ 10');
    expect(text).toContain('распилено 3/6');
  });

  it('shows members + laminated progress for a bath card whose composition has no items', () => {
    const bathCard = card({ id: 'bath-1', kind: 'bath', column: 'baths' });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          session={session({
            cards: [bathCard],
            orders: [{ orderId: 20, orderName: 'Заказ 20' }],
            members: [{ kind: 'bath', id: 'bath-1', orderId: 20, detailId: 200, quantity: 5 }],
            progress: [{ kind: 'bath', id: 'bath-1', orderId: 20, detailId: 200, member: 5, cut: 5, laminated: 2 }],
            presentation: [{ kind: 'bath', id: 'bath-1', stale: false, composition: { items: [] }, live: null }],
          })}
        />,
      );
    });
    const members = view.root.findAllByProps({ className: 'mdf-published-card__members' });
    expect(members).toHaveLength(1);
    const text = textOf(members[0]!);
    expect(text).toContain('закатано 2/5');
  });

  it('shows the same whole-position totals on two different cards sharing one position — never doubled', () => {
    const cardA = card({ id: 'packet-a' });
    const cardB = card({ id: 'packet-b' });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          session={session({
            cards: [cardA, cardB],
            orders: [{ orderId: 10, orderName: 'Заказ 10' }],
            members: [
              { kind: 'packet', id: 'packet-a', orderId: 10, detailId: 100, quantity: 6 },
              { kind: 'packet', id: 'packet-b', orderId: 10, detailId: 100, quantity: 4 },
            ],
            positions: [{ orderId: 10, detailId: 100, required: 10, cut: 6, rolled: 0, creditedCut: 6, creditedRolled: 0, remaining: 4, issues: [] }],
            presentation: [
              { kind: 'packet', id: 'packet-a', stale: false, composition: { items: [] }, live: null },
              { kind: 'packet', id: 'packet-b', stale: false, composition: { items: [] }, live: null },
            ],
          })}
        />,
      );
    });
    const positionsBlocks = view.root.findAllByProps({ className: 'mdf-published-card__positions' });
    expect(positionsBlocks).toHaveLength(2);
    const textA = textOf(positionsBlocks[0]!);
    const textB = textOf(positionsBlocks[1]!);
    expect(textA).toContain('6/10');
    expect(textB).toContain('6/10');
  });
});

describe('MdfPublishedBoardView: §5.6 finding 9 — move permission', () => {
  it('disables the move control with the permission reason when canMove is false, regardless of readiness', () => {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          canMove={false}
          session={session()}
        />,
      );
    });
    const dropdown = view.root.findByType('mock-dropdown' as never);
    expect(dropdown.props.disabled).toBe(true);
    const tooltip = view.root.findByType('mock-tooltip' as never);
    expect(tooltip.props.title).toBe('Нет права менять производственные этапы');
  });

  it('enables the move control when canMove is true and the card is otherwise ready', () => {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        <MdfPublishedBoardView
          {...baseProps}
          canMove
          session={session()}
        />,
      );
    });
    const dropdown = view.root.findByType('mock-dropdown' as never);
    expect(dropdown.props.disabled).toBe(false);
  });
});
