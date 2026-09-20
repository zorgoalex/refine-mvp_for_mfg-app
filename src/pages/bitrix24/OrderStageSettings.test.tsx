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
