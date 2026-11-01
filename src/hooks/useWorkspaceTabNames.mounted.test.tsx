import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  pathname: '/orders',
  generation: 1,
  userId: 89 as number | null,
  getOne: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useLocation: () => ({ pathname: env.pathname, search: '', hash: '', state: null, key: 'k' }),
}));
vi.mock('@refinedev/core', () => ({
  useResource: () => ({ resources: [{ name: 'clients', show: '/clients/show/:id', meta: { idColumnName: 'client_id' } }] }),
  useDataProvider: () => () => ({ getOne: env.getOne }),
}));
import { authSession } from '../api/authSession';
import { useTabStore } from '../stores/tabStore';
import { ACTIVE_TAB_GRACE_MS, useWorkspaceTabNames } from './useWorkspaceTabNames';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

const CLIENT = '/clients/show/2606';
const labelOf = (key: string) => useTabStore.getState().tabs.find((tab) => tab.key === key)?.label;
const setTabs = (tabs: Array<{ key: string; label: string }>) => useTabStore.setState({
  tabs: tabs.map((tab) => ({ ...tab, path: tab.key, resource: 'clients', dirty: false })),
});

function Probe() {
  useWorkspaceTabNames();
  return null;
}

describe('useWorkspaceTabNames mounted in the layout', () => {
  let renderer: ReactTestRenderer | undefined;
  const render = async () => {
    await act(async () => {
      if (renderer) renderer.update(<Probe />);
      else renderer = create(<Probe />);
    });
  };
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

  beforeEach(() => {
    env.pathname = '/orders';
    env.generation = 1;
    env.userId = 89;
    env.getOne.mockReset();
    vi.spyOn(authSession, 'getSessionGeneration').mockImplementation(() => env.generation);
    vi.spyOn(authSession, 'getUser').mockImplementation(() => (env.userId === null ? null : { id: env.userId }) as never);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names a background tab from the record', async () => {
    const read = deferred<{ data: Record<string, unknown> }>();
    env.getOne.mockReturnValue(read.promise);
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    await act(async () => { read.resolve({ data: { client_id: 2606, client_name: 'Ғибрат Шадет' } }); });
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · Ғибрат Шадет');
    await render();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · Ғибрат Шадет'); // следующий проход имя не стирает
    expect(env.getOne).toHaveBeenCalledTimes(1);
  });

  it('keeps a loaded name that looks like the old format (client «#2606»), also after a reload', async () => {
    env.getOne.mockResolvedValue({ data: { client_id: 2606, client_name: '#2606' } });
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · #2606');
    // «перезагрузка»: новый экземпляр хука видит сохранённое имя; чтение отказывает — имя не трогается
    act(() => renderer?.unmount());
    renderer = undefined;
    env.getOne.mockReset().mockRejectedValue(new Error('forbidden'));
    await render();
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · #2606');
    expect(env.getOne).not.toHaveBeenCalled();
  });

  it('the open tab whose page confirms the same text before the wait is left alone', async () => {
    vi.useFakeTimers();
    env.getOne.mockResolvedValue({ data: { client_name: 'Другое' } });
    env.pathname = CLIENT;
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    act(() => useTabStore.getState().setTabTitle(CLIENT, 'Клиенты · Просмотр · #2606'));
    await render();
    await act(async () => { vi.advanceTimersByTime(ACTIVE_TAB_GRACE_MS * 2); });
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · #2606');
    expect(env.getOne).not.toHaveBeenCalled();
  });

  it('drops a late answer after logout and login as another user; the new user reads the tab with own rights', async () => {
    const read = deferred<{ data: Record<string, unknown> }>();
    const readOfB = deferred<{ data: Record<string, unknown> }>();
    env.getOne.mockReturnValueOnce(read.promise).mockReturnValueOnce(readOfB.promise);
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    env.generation = 2;
    env.userId = 158;
    await act(async () => { read.resolve({ data: { client_name: 'Клиент, прочитанный под A' } }); });
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр'); // ответ сессии A не применён
    expect(env.getOne).toHaveBeenCalledTimes(2); // вкладку перечитали уже в сессии B
    await act(async () => { readOfB.resolve({ data: { client_name: 'Клиент B' } }); });
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · Клиент B');
  });

  it('drops an answer that arrives after unmount', async () => {
    const read = deferred<{ data: Record<string, unknown> }>();
    env.getOne.mockReturnValue(read.promise);
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    act(() => renderer?.unmount());
    renderer = undefined;
    await act(async () => { read.resolve({ data: { client_name: 'Ғибрат Шадет' } }); });
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр');
  });

  it('keeps the id-free label after a failed read and does not retry it', async () => {
    env.getOne.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    await flush();
    await render();
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр');
    expect(env.getOne).toHaveBeenCalledTimes(1);
  });

  it('a name the page set during the read wins', async () => {
    const read = deferred<{ data: Record<string, unknown> }>();
    env.getOne.mockReturnValue(read.promise);
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    act(() => useTabStore.getState().setTabTitle(CLIENT, 'Клиенты · Просмотр · Имя со страницы'));
    await act(async () => { read.resolve({ data: { client_name: 'Другое' } }); });
    await flush();
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · Имя со страницы');
  });

  it('leaves the open tab to its page for a while, then names it; unmount cancels the wait', async () => {
    vi.useFakeTimers();
    env.getOne.mockResolvedValue({ data: { client_name: 'Ғибрат Шадет' } });
    env.pathname = CLIENT;
    setTabs([{ key: CLIENT, label: 'Клиенты · Просмотр' }]);
    await render();
    expect(env.getOne).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(ACTIVE_TAB_GRACE_MS); });
    await flush();
    expect(env.getOne).toHaveBeenCalledTimes(1);
    expect(labelOf(CLIENT)).toBe('Клиенты · Просмотр · Ғибрат Шадет');

    env.getOne.mockClear();
    env.pathname = '/clients/show/7'; // сначала открытая вкладка, потом список: иначе она на миг фоновая
    await act(async () => { setTabs([{ key: '/clients/show/7', label: 'Клиенты · Просмотр' }]); });
    await render();
    act(() => renderer?.unmount());
    renderer = undefined;
    await act(async () => { vi.advanceTimersByTime(ACTIVE_TAB_GRACE_MS * 2); });
    expect(env.getOne).not.toHaveBeenCalled();
  });
});
