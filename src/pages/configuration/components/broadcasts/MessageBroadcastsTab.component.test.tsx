import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../api/apiError';
import { MessageBroadcastsTab } from './MessageBroadcastsTab';

const mockApi = vi.hoisted(() => ({ list: vi.fn() }));
const legacyRender = vi.hoisted(() => vi.fn());

vi.mock('../../../../api/broadcastsApi', () => ({ broadcastsApi: mockApi }));
vi.mock('../DailyOrderDigestConfig', () => ({
  DailyOrderDigestConfig: () => { legacyRender(); return React.createElement('div', { 'data-testid': 'legacy' }); },
}));
vi.mock('./BroadcastsPanel', () => ({
  BroadcastsPanel: (props: { initial: { broadcasts: unknown[] } }) =>
    React.createElement('div', { 'data-testid': 'new-ui' }, `count:${props.initial.broadcasts.length}`),
}));
vi.mock('antd', () => {
  const primitive = (tag: string) => (props: Record<string, unknown>) => React.createElement(tag, { onClick: props.onClick }, (props.message ?? props.children) as React.ReactNode, props.action as React.ReactNode);
  return { Alert: primitive('aside'), Button: primitive('button'), Spin: primitive('span') };
});

let tree: ReactTestRenderer | undefined;

async function mount() {
  await act(async () => { tree = create(React.createElement(MessageBroadcastsTab)); });
  await act(async () => { await Promise.resolve(); });
}

const has = (id: string) => tree!.root.findAll((n) => n.props['data-testid'] === id).length > 0;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined; });

describe('MessageBroadcastsTab feature detection', () => {
  it('renders the legacy digest UI on a 404 (old backend)', async () => {
    mockApi.list.mockRejectedValue(new ApiError({ code: 'NOT_FOUND', message: 'nf', status: 404 }));
    await mount();
    expect(has('legacy')).toBe(true);
    expect(has('new-ui')).toBe(false);
  });

  it('renders the new UI on success and never mounts the legacy component', async () => {
    mockApi.list.mockResolvedValue({ broadcasts: [{ id: 1 }], control: {}, runtime: {}, limits: { maxActive: 20 } });
    await mount();
    expect(has('new-ui')).toBe(true);
    expect(has('legacy')).toBe(false);
    expect(legacyRender).not.toHaveBeenCalled();
  });

  it('shows an error with retry for other failures, and retry recovers', async () => {
    mockApi.list.mockRejectedValueOnce(new ApiError({ code: 'INTERNAL_ERROR', message: 'server down', status: 500 }));
    await mount();
    expect(has('legacy')).toBe(false);
    expect(has('new-ui')).toBe(false);
    const retry = tree!.root.findAllByType('button').find((b) => b.children.join('') === 'Повторить');
    expect(retry).toBeDefined();
    mockApi.list.mockResolvedValue({ broadcasts: [], control: {}, runtime: {}, limits: { maxActive: 20 } });
    await act(async () => { retry!.props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    expect(has('new-ui')).toBe(true);
    expect(mockApi.list).toHaveBeenCalledTimes(2);
  });
});
