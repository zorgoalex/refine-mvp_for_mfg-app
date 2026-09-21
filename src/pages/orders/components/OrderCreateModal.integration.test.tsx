import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authSession } from '../../../api/authSession';
import {
  clearAllOrderDraftStores, getOrderDraftStorageKey, getOrderDraftStore, NEW_ORDER_KEY,
} from '../../../stores/orderFormStore';
import { OrderCreateModal } from './OrderCreateModal';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('antd', () => ({
  Modal: Object.assign(({ children, ...props }: any) => <section {...props}>{children}</section>, { confirm }),
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Space: ({ children }: any) => <div>{children}</div>,
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
}));
vi.mock('@ant-design/icons', () => ({ ExpandOutlined: () => null, MinusOutlined: () => null }));
vi.mock('../../../components/DraggableModalWrapper', () => ({ DraggableModalWrapper: ({ children }: any) => children }));
vi.mock('./OrderForm', () => ({ OrderForm: (props: any) => <article {...props} /> }));

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
  };
}

describe('new order modal draft recovery', () => {
  let renderer: ReactTestRenderer | undefined;
  const onClose = vi.fn();
  const tree = (open = true) => <MemoryRouter><OrderCreateModal open={open} onClose={onClose} /></MemoryRouter>;
  const openModal = () => act(() => {
    renderer = create(tree());
  });
  const seedDraft = () => {
    const store = getOrderDraftStore(NEW_ORDER_KEY);
    store.getState().setHeader({ order_name: 'Unsaved order', client_id: 12 });
    for (let index = 1; index <= 3; index += 1) {
      store.getState().addDetail({ height: 600 + index * 10, width: 400 + index * 10, quantity: index } as any);
    }
    return store;
  };
  const expectRecovered = () => {
    const state = getOrderDraftStore(NEW_ORDER_KEY).getState();
    expect(state.header).toMatchObject({ order_name: 'Unsaved order', client_id: 12 });
    expect(state.details.map(({ height, width, quantity }) => [height, width, quantity]))
      .toEqual([[610, 410, 1], [620, 420, 2], [630, 430, 3]]);
    expect(state.isDirty).toBe(true);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('sessionStorage', memoryStorage());
    authSession.setAccessToken('token-a');
    authSession.setUser({ id: '7', username: 'test', role: 'admin', permissions: ['orders.view'] });
    confirm.mockReset();
    onClose.mockReset();
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    clearAllOrderDraftStores();
    authSession.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves all unsaved fields and details on open and remount', () => {
    seedDraft();
    openModal();
    expectRecovered();
    act(() => renderer!.unmount());
    openModal();
    act(() => vi.advanceTimersByTime(50));
    expect(renderer!.root.findAllByType('article')).toHaveLength(1);
    expectRecovered();
  });

  it('rehydrates the same-owner sessionStorage draft before opening', () => {
    seedDraft();
    const key = getOrderDraftStorageKey(NEW_ORDER_KEY);
    const persisted = sessionStorage.getItem(key)!;
    clearAllOrderDraftStores();
    sessionStorage.setItem(key, persisted);
    openModal();
    expectRecovered();
  });

  it('retains the draft when discard confirmation is cancelled and deletes on confirmation', () => {
    seedDraft();
    openModal();
    act(() => renderer!.root.findByType('section').props.onCancel());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expectRecovered();
    act(() => confirm.mock.calls[0][0].onOk());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(getOrderDraftStorageKey(NEW_ORDER_KEY))).toBeNull();
    expect(getOrderDraftStore(NEW_ORDER_KEY).getState().details).toEqual([]);
  });

  it('starts fresh after a saved order rather than recovering it as another create', () => {
    const store = seedDraft();
    store.getState().setHeader({ order_id: 123 });
    store.getState().setDirty(false);
    openModal();
    const state = getOrderDraftStore(NEW_ORDER_KEY).getState();
    expect(state.header.order_id).toBeUndefined();
    expect(state.details).toEqual([]);
    expect(state.isDirty).toBe(false);
  });

  it('does not recover another actor or permission scope draft', () => {
    seedDraft();
    authSession.setUser({ id: '8', username: 'other', role: 'admin', permissions: ['orders.view'] });
    openModal();
    expect(getOrderDraftStore(NEW_ORDER_KEY).getState().details).toEqual([]);
    act(() => renderer!.unmount());
    authSession.setUser({ id: '7', username: 'test', role: 'admin', permissions: ['orders.view', 'orders.create'] });
    openModal();
    expect(getOrderDraftStore(NEW_ORDER_KEY).getState().details).toEqual([]);
  });
});
