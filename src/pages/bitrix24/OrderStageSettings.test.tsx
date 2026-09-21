import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bitrix24StagesApi as api,
  type StageState,
} from '../../api/bitrix24StagesApi';
import { OrderStageSettings } from './OrderStageSettings';
vi.mock('../../api/bitrix24StagesApi', () => ({
  bitrix24StagesApi: {
    state: vi.fn(),
    refresh: vi.fn(),
    previewSettings: vi.fn(),
    applySettings: vi.fn(),
    previewReconcile: vi.fn(),
    applyReconcile: vi.fn(),
    job: vi.fn(),
  },
}));
// Native test controls retain component props; no browser/network dependency.
vi.mock('antd', () => {
  const node = (type: string) => (p: Record<string, unknown>) =>
    React.createElement(type, p, p.children as React.ReactNode);
  const Space = Object.assign(node('space'), { Compact: node('compact') });
  return {
    Alert: node('alert'),
    Button: node('button'),
    Checkbox: node('checkbox'),
    Collapse: Object.assign(node('collapse'), { Panel: node('panel') }),
    Form: Object.assign(node('form'), { Item: node('field') }),
    Input: node('input'),
    Modal: node('modal'),
    Select: node('select'),
    Space,
    Spin: node('spin'),
    Switch: node('switch'),
    Tag: node('tag'),
    Typography: { Text: node('text'), Paragraph: node('p'), Title: node('h3') },
  };
});
vi.mock('../../ui/tooltipDelay', () => ({
  Table: (props: unknown) =>
    React.createElement('table', props as React.Attributes),
}));
const state: StageState = {
  config: {
    member_id: 'E2E',
    category_id: 0,
    completed_status_id: 8,
    enabled: false,
    binding_locked: true,
    version: 1,
    epoch: 1,
  },
  statuses: [
    { id: 1, name: 'Новый', code: 'new', color: '', active: true, used: true },
    {
      id: 8,
      name: 'Завершен',
      code: 'done',
      color: '',
      active: true,
      used: false,
    },
  ],
  catalogs: [
    {
      member_id: 'E2E',
      category_id: 0,
      category_name: 'Main',
      fetched_at: '2026-09-20',
      stages: [
        { id: 'NEW', name: 'Новая', semantics: '', sort: 10, color: '' },
        { id: 'WON', name: 'Успех', semantics: 'S', sort: 100, color: '' },
      ],
    },
  ],
  mappings: [
    { order_status_id: 1, stage_id: 'NEW' },
    { order_status_id: 8, stage_id: 'WON' },
  ],
  counts: [],
  runtime: { forward: 'in_process', reverse: 'in_process' },
};
describe('independent stage settings UI', () => {
  beforeEach(() => vi.resetAllMocks());
  const preview = (selection?: {
    sort: 'asc' | 'desc';
    orderName?: string;
  }) => ({
    job_id: 'preview',
    kind: 'reconcile' as const,
    expires_at: '2099-01-01',
    results: {},
    payload: {
      rows: [
        { orderId: '123', orderName: '2947', bitrixId: '700', error: null },
      ],
      hasMore: true,
      nextCursor: '123',
      ...(selection ? { selection } : {}),
    },
  });
  it('defaults newest, sends exact filters, retains job selection between pages, resets row selection', async () => {
    vi.mocked(api.state).mockResolvedValue({
      ...state,
      config: { ...state.config, enabled: true },
    });
    vi.mocked(api.previewReconcile).mockResolvedValue(
      preview({ sort: 'desc', orderName: '2947' })
    );
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<OrderStageSettings />);
    });
    const button = (label: string) =>
      view.root
        .findAllByType('button')
        .find((x) => x.props.children === label)!;
    expect(
      view.root.findByProps({ 'aria-label': 'Порядок заказов для сверки' })
        .props.value
    ).toBe('desc');
    act(() =>
      view.root
        .findByProps({ 'aria-label': 'Заказ для сверки' })
        .props.onChange({ target: { value: ' 2947 ' } })
    );
    await act(async () =>
      button('Предпросмотр сверки — 25 заказов').props.onClick()
    );
    expect(api.previewReconcile).toHaveBeenLastCalledWith(0, {
      sort: 'desc',
      orderName: '2947',
    });
    const table = () =>
      view.root
        .findAllByType('table')
        .find((x) => x.props.rowKey === 'orderId')!;
    act(() => table().props.rowSelection.onChange(['123']));
    expect(table().props.rowSelection.selectedRowKeys).toEqual(['123']);
    // Unsaved underlying form edits must not change the open job's cursor/query.
    act(() =>
      view.root
        .findByProps({ 'aria-label': 'Порядок заказов для сверки' })
        .props.onChange('asc')
    );
    await act(async () => button('Следующие 25 заказов').props.onClick());
    expect(api.previewReconcile).toHaveBeenLastCalledWith(123, {
      sort: 'desc',
      orderName: '2947',
    });
    expect(table().props.rowSelection.selectedRowKeys).toEqual([]);
    expect(api.applyReconcile).not.toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('validates ID, supports oldest and clears search when switching identity fields', async () => {
    vi.mocked(api.state).mockResolvedValue({
      ...state,
      config: { ...state.config, enabled: true },
    });
    vi.mocked(api.previewReconcile).mockResolvedValue(preview());
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<OrderStageSettings />);
    });
    const input = () =>
      view.root.findByProps({ 'aria-label': 'Заказ для сверки' });
    const button = () =>
      view.root
        .findAllByType('button')
        .find((x) => x.props.children === 'Предпросмотр сверки — 25 заказов')!;
    act(() =>
      view.root
        .findByProps({ 'aria-label': 'Поле поиска заказа для сверки' })
        .props.onChange('orderId')
    );
    act(() =>
      input().props.onChange({ target: { value: '9007199254740992' } })
    );
    expect(button().props.disabled).toBe(true);
    act(() => input().props.onChange({ target: { value: '11634' } }));
    act(() =>
      view.root
        .findByProps({ 'aria-label': 'Порядок заказов для сверки' })
        .props.onChange('asc')
    );
    await act(async () => button().props.onClick());
    expect(api.previewReconcile).toHaveBeenLastCalledWith(0, {
      sort: 'asc',
      orderId: 11634,
    });
    act(() =>
      view.root
        .findByProps({ 'aria-label': 'Поле поиска заказа для сверки' })
        .props.onChange('orderName')
    );
    expect(input().props.value).toBe('');
    await act(async () => button().props.onClick());
    expect(api.previewReconcile).toHaveBeenLastCalledWith(0, { sort: 'asc' });
    act(() => view.unmount());
  });
  it('continues legacy jobs ascending and displays empty results without auto-apply', async () => {
    vi.mocked(api.state).mockResolvedValue({
      ...state,
      jobs: [{ job_id: 'old', kind: 'reconcile', created_at: '2026-09-20' }],
    });
    vi.mocked(api.job).mockResolvedValue(preview());
    vi.mocked(api.previewReconcile).mockResolvedValue({
      ...preview(),
      payload: { rows: [], hasMore: false },
    });
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<OrderStageSettings />);
    });
    await act(async () =>
      view.root
        .findByProps({ 'aria-label': 'Ранее выполненные операции стадий' })
        .props.onChange('old')
    );
    await act(async () =>
      view.root
        .findAllByType('button')
        .find((x) => x.props.children === 'Следующие 25 заказов')!
        .props.onClick()
    );
    expect(api.previewReconcile).toHaveBeenLastCalledWith(123, { sort: 'asc' });
    const table = view.root
      .findAllByType('table')
      .find((x) => x.props.rowKey === 'orderId')!;
    expect(table.props.dataSource).toEqual([]);
    expect(table.props.locale.emptyText).toContain('не найдено');
    expect(api.applyReconcile).not.toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('fails independently and offers reload; never writes on mount', async () => {
    vi.mocked(api.state).mockRejectedValue(new Error('Catalog unavailable'));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<OrderStageSettings />);
    });
    expect(view.root.findByType('alert').props.description).toBe(
      'Catalog unavailable'
    );
    expect(api.applySettings).not.toHaveBeenCalled();
    act(() => view.unmount());
  });
  it('locks funnel, previews settings before apply and requires automation acknowledgement', async () => {
    vi.mocked(api.state).mockResolvedValue(state);
    vi.mocked(api.previewSettings).mockResolvedValue({
      job_id: 'job',
      kind: 'settings',
      expires_at: '2026-09-21',
      results: {},
      payload: {
        settings: {
          version: 1,
          categoryId: 0,
          completedStatusId: 8,
          enabled: false,
          mappings: [],
        },
        affectedOrderIds: [],
      },
    });
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<OrderStageSettings />);
    });
    expect(
      view.root.findByProps({ 'aria-label': 'Существующая воронка Bitrix' })
        .props.disabled
    ).toBe(true);
    const button = (text: string) =>
      view.root.findAllByType('button').find((b) => b.props.children === text)!;
    await act(async () => {
      await button('Предпросмотр изменения настроек').props.onClick();
    });
    expect(api.previewSettings).toHaveBeenCalledOnce();
    expect(api.applySettings).not.toHaveBeenCalled();
    expect(button('Подтвердить').props.disabled).toBe(true);
    act(() =>
      view.root
        .findByType('checkbox')
        .props.onChange({ target: { checked: true } })
    );
    expect(button('Подтвердить').props.disabled).toBe(false);
    act(() => view.unmount());
  });
});
