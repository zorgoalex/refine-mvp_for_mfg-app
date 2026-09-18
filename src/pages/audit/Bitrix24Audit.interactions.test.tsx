import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditApi } from '../../api/auditApi';
import { AuditOrderLookup, Bitrix24Audit } from './Bitrix24Audit';

vi.mock('../../api/auditApi', () => ({
  auditApi: {
    list: vi.fn(),
    bitrixStatus: vi.fn(),
    bitrixQueue: vi.fn(),
    bitrixEvents: vi.fn(),
    orderOptions: vi.fn(),
  },
}));
vi.mock('../../config/featureFlags', () => ({
  featureFlags: { useBackendPermissions: false },
}));
vi.mock('antd', () => {
  const component = (name: string) => (props: any) =>
    React.createElement(name, props, props.children);
  const form = { resetFields: vi.fn() };
  return {
    Alert: component('Alert'),
    Button: component('Button'),
    Card: component('Card'),
    Input: component('Input'),
    InputNumber: component('InputNumber'),
    Select: component('Select'),
    Space: component('Space'),
    Table: component('Table'),
    Tabs: component('Tabs'),
    Tag: component('Tag'),
    DatePicker: { RangePicker: component('RangePicker') },
    Form: Object.assign(component('Form'), {
      Item: component('FormItem'),
      useForm: () => [form],
    }),
    Typography: {
      Title: component('Title'),
      Text: component('Text'),
      Paragraph: component('Paragraph'),
    },
  };
});

const empty = { data: [], pagination: { total: 0, page: 1, pageSize: 50 } };
describe('Bitrix journal interactions', () => {
  let view: ReactTestRenderer;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(auditApi.list).mockResolvedValue(empty as never);
    vi.mocked(auditApi.bitrixQueue).mockResolvedValue(empty);
    vi.mocked(auditApi.bitrixStatus).mockResolvedValue({
      data: [],
      fetchedAt: '2026-09-18T00:00:00Z',
    });
    vi.mocked(auditApi.bitrixEvents).mockResolvedValue({ data: [] });
    vi.mocked(auditApi.orderOptions).mockResolvedValue({
      data: [],
      requestId: 'E2E',
    });
  });
  afterEach(() => {
    act(() => view?.unmount());
    vi.useRealTimers();
  });
  async function mount() {
    await act(async () => {
      view = create(<Bitrix24Audit />);
    });
  }
  const host = (name: string) => view.root.findByType(name as never);
  it('submits filters and resets to integration scope, never inclusive general history', async () => {
    await mount();
    await act(async () =>
      host('Form').props.onFinish({
        orderId: 11697,
        bitrixOutcome: 'attention',
      })
    );
    expect(auditApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: 'bitrix24',
        orderIds: [11697],
        bitrixOutcome: 'attention',
      })
    );
    await act(async () =>
      view.root
        .findAllByType('Button' as never)
        .find((b) => b.props.children === 'Сбросить')!
        .props.onClick()
    );
    const query = vi.mocked(auditApi.list).mock.calls.at(-1)![0];
    expect(query).toMatchObject({ scope: 'bitrix24', page: 1 });
    expect(query.orderIds).toBeUndefined();
    expect(query.bitrixOutcome).toBeUndefined();
  });
  it('ignores older list response after changing filters', async () => {
    let resolveOld!: (value: any) => void;
    vi.mocked(auditApi.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    await mount();
    vi.mocked(auditApi.list).mockResolvedValueOnce({
      ...empty,
      data: [{ auditId: 'new' }],
    } as never);
    await act(async () => host('Form').props.onFinish({ orderId: 11697 }));
    await act(async () => resolveOld({ ...empty, data: [{ auditId: 'old' }] }));
    expect(host('Table').props.dataSource).toEqual([{ auditId: 'new' }]);
  });
  it('switches to live queue with cleared event filters and supports an unmapped order ID', async () => {
    await mount();
    await act(async () =>
      host('Form').props.onFinish({
        events: ['crm_sync.failed'],
        bitrixOutcome: 'error',
      })
    );
    await act(async () => host('Tabs').props.onChange('queue'));
    await act(async () =>
      host('Form').props.onFinish({ orderId: 11697, status: 'pending' })
    );
    const query = vi.mocked(auditApi.bitrixQueue).mock.calls.at(-1)![0];
    expect(query).toMatchObject({
      direction: 'forward',
      orderId: 11697,
      status: 'pending',
      page: 1,
    });
    expect(query).not.toHaveProperty('events');
    expect(query).not.toHaveProperty('bitrixOutcome');
  });
  it('searches the server by order number and offers exact ID when no option exists', async () => {
    await act(async () => {
      view = create(<AuditOrderLookup />);
    });
    await act(async () => host('Select').props.onSearch('11697'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(auditApi.orderOptions).toHaveBeenLastCalledWith({
      search: '11697',
      ids: [],
      limit: 50,
    });
    expect(host('Select').props.options).toContainEqual({
      value: 11697,
      label: 'Точный ID заказа: 11697',
    });
  });
});
