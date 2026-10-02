import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditApi } from '../../../../api/auditApi';
import { ordersApi } from '../../../../api/ordersApi';
import { can } from '../../../../utils/permissions';
import { OrderHistorySpoiler } from './OrderHistorySpoiler';

vi.mock('../../../../api/auditApi', () => ({ auditApi: { list: vi.fn() } }));
vi.mock('../../../../api/ordersApi', () => ({ ordersApi: { history: vi.fn() } }));
vi.mock('../../../../utils/permissions', () => ({ can: vi.fn() }));
vi.mock('antd', () => ({
  Button: (props: any) => React.createElement('button', { type: 'button', onClick: props.onClick }, props.children),
}));
vi.mock('@ant-design/icons', () => ({ RightOutlined: () => null }));

const historyEvent = (auditId: string, statusName: string | null = null) => ({
  auditId,
  event: 'orders.status_change',
  createdAt: '2026-10-01T07:30:00.000Z',
  actorName: 'manager',
  entityType: 'order',
  statusField: statusName ? 'orderStatus' : null,
  statusName,
  stageCode: null,
});
const page = (data: unknown[], total = data.length) => ({ data, pagination: { page: 1, pageSize: 20, total, totalPages: 1 } });

let renderer: ReactTestRenderer;

const mount = async (orderId: number) => {
  await act(async () => {
    renderer = create(<OrderHistorySpoiler orderId={orderId} />);
  });
};
const toggle = () => renderer.root.findByProps({ className: 'order-history__summary' });
const open = async () => {
  await act(async () => {
    toggle().props.onClick();
  });
};
const buttonWithText = (label: string) => renderer.root.findAll(
  (node) => node.type === 'button' && node.children.some((child) => typeof child === 'string' && child.includes(label)),
)[0];
const items = () => renderer.root.findAllByProps({ className: 'order-history__item' });
const text = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  vi.mocked(auditApi.list).mockReset();
  vi.mocked(ordersApi.history).mockReset();
  vi.mocked(can).mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
});

describe('OrderHistorySpoiler (mounted)', () => {
  it('is collapsed by default and reads nothing until opened', async () => {
    vi.mocked(can).mockReturnValue(false);
    await mount(15);

    expect(toggle().props['aria-expanded']).toBe(false);
    expect(items()).toHaveLength(0);
    expect(ordersApi.history).not.toHaveBeenCalled();
    expect(auditApi.list).not.toHaveBeenCalled();
  });

  it('without audit.view reads the order history and never the journal', async () => {
    vi.mocked(can).mockReturnValue(false);
    vi.mocked(ordersApi.history).mockResolvedValue(page([historyEvent('a1', 'В производстве')]) as never);
    await mount(15);
    await open();

    expect(can).toHaveBeenCalledWith('audit.view');
    expect(ordersApi.history).toHaveBeenCalledWith(15, { page: 1, pageSize: 20 });
    expect(auditApi.list).not.toHaveBeenCalled();
    expect(items()).toHaveLength(1);
    expect(text()).toContain('В производстве');
  });

  it('with audit.view keeps the journal source', async () => {
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(auditApi.list).mockResolvedValue(page([]) as never);
    await mount(15);
    await open();

    expect(auditApi.list).toHaveBeenCalledWith({ scope: 'business', orderIds: [15], page: 1, pageSize: 20 });
    expect(ordersApi.history).not.toHaveBeenCalled();
    expect(text()).toContain('Записей истории по заказу нет');
  });

  it.each([403, 404, 503])('shows a retry on HTTP %s and repeats the SAME source', async (statusCode) => {
    vi.mocked(can).mockReturnValue(false);
    vi.mocked(ordersApi.history)
      .mockRejectedValueOnce(Object.assign(new Error('failed'), { statusCode }))
      .mockResolvedValueOnce(page([historyEvent('a1')]) as never);
    await mount(15);
    await open();

    expect(text()).toContain('Не удалось загрузить историю заказа');
    expect(items()).toHaveLength(0);
    // no silent retry loop
    expect(ordersApi.history).toHaveBeenCalledTimes(1);

    await act(async () => {
      buttonWithText('Повторить').props.onClick();
    });

    expect(ordersApi.history).toHaveBeenCalledTimes(2);
    expect(auditApi.list).not.toHaveBeenCalled();
    expect(items()).toHaveLength(1);
  });

  it('drops loaded events when the order changes and ignores the late answer of the previous order', async () => {
    vi.mocked(can).mockReturnValue(false);
    let resolveFirst: (value: unknown) => void = () => undefined;
    vi.mocked(ordersApi.history)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }) as never)
      .mockResolvedValueOnce(page([historyEvent('b1', 'Готов к выдаче')]) as never);
    await mount(15);
    await open();

    await act(async () => {
      renderer.update(<OrderHistorySpoiler orderId={16} />);
    });
    expect(ordersApi.history).toHaveBeenLastCalledWith(16, { page: 1, pageSize: 20 });
    expect(text()).toContain('Готов к выдаче');

    await act(async () => {
      resolveFirst(page([historyEvent('a1', 'ЧУЖОЙ ЗАКАЗ')]));
    });
    expect(text()).not.toContain('ЧУЖОЙ ЗАКАЗ');
    expect(items()).toHaveLength(1);
  });

  it('loads the next page on «Показать ещё» and appends it', async () => {
    vi.mocked(can).mockReturnValue(false);
    vi.mocked(ordersApi.history)
      .mockResolvedValueOnce(page([historyEvent('a1')], 2) as never)
      .mockResolvedValueOnce(page([historyEvent('a2')], 2) as never);
    await mount(15);
    await open();
    expect(items()).toHaveLength(1);

    await act(async () => {
      buttonWithText('Показать ещё').props.onClick();
    });

    expect(ordersApi.history).toHaveBeenLastCalledWith(15, { page: 2, pageSize: 20 });
    expect(items()).toHaveLength(2);
  });
});
