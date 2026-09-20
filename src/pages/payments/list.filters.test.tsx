import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  pagination: undefined as false | { total?: number } | undefined,
  canViewUsers: true,
  setFilters: vi.fn(), resetFields: vi.fn(), useSelect: vi.fn(),
}));
vi.mock('@ant-design/icons', () => ({
  FilterOutlined: () => null, ClearOutlined: () => null, CheckCircleOutlined: () => null,
}));
vi.mock('@refinedev/core', () => ({
  useMany: () => ({ data: { data: [] } }), useNavigation: () => ({ show: vi.fn() }),
}));
vi.mock('@refinedev/antd', () => ({
  List: ({ children, headerButtons }: any) => <>{headerButtons({ defaultButtons: null })}{children}</>,
  ShowButton: () => null, EditButton: () => null,
  useSelect: (props: unknown) => { fixture.useSelect(props); return { selectProps: { options: [] } }; },
}));
vi.mock('../../hooks/usePersistentTable', () => ({
  usePersistentTable: () => ({
    tableProps: { dataSource: [], pagination: fixture.pagination },
    pageSize: 10, setCurrent: vi.fn(), setPageSize: vi.fn(),
    filters: [], setFilters: fixture.setFilters,
  }),
}));
vi.mock('../../hooks/useHighlightRow', () => ({ useHighlightRow: () => ({ highlightProps: {} }) }));
vi.mock('../../hooks/useDeviceTier', () => ({ useIsMobile: () => false }));
vi.mock('../../utils/auth', () => ({ authStorage: { getUser: () => ({}) } }));
vi.mock('../../utils/resourcePermissions', () => ({ canQueryUsersResource: () => fixture.canViewUsers }));
vi.mock('./mobile/PaymentCardList', () => ({ PaymentCardList: () => null }));
vi.mock('../../components/OrderDeletedTag', () => ({ OrderDeletedTag: () => null, orderDeletedReferenceClassName: () => '' }));
vi.mock('../../ui/tooltipDelay', () => ({ Table: Object.assign(() => null, { Column: () => null }) }));
vi.mock('antd', () => {
  const Box = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    Space: Box, Row: Box, Col: Box, Card: Box,
    Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
    Form: Object.assign(({ children, onFinish }: any) => <form onSubmit={onFinish}>{children}</form>, {
      Item: Box, useForm: () => [{ resetFields: fixture.resetFields }],
    }),
    Select: (props: any) => React.createElement('test-select', props),
    Input: () => null, InputNumber: () => null, DatePicker: { RangePicker: () => null },
    Typography: { Text: Box },
  };
});

import { PaymentList } from './list';
let tree: ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  fixture.pagination = { total: 42 };
  fixture.canViewUsers = true;
});
afterEach(() => {
  if (tree) act(() => tree.unmount());
  vi.unstubAllGlobals();
});

function openFilters() {
  act(() => { tree = create(<PaymentList />); });
  act(() => tree.root.findAllByType('button').find(button => button.children.includes('Фильтры'))!.props.onClick());
  return tree.root.findAllByType('test-select');
}

describe('payment list filter contracts', () => {
  it.each(['Выберите заказ', 'Пользователь'])('%s: keeps case-insensitive string matching', placeholder => {
    const select = openFilters().find(select => select.props.placeholder === placeholder)!;
    expect(select.props.filterOption('тЕсТ', { label: 'Тест заказа' })).toBe(true);
    expect(select.props.filterOption('другое', { label: 'Тест заказа' })).toBe(false);
  });

  it.each(['Выберите заказ', 'Пользователь'])('%s: accepts numbers and safely ignores unsupported labels', placeholder => {
    const select = openFilters().find(select => select.props.placeholder === placeholder)!;
    expect(select.props.filterOption('23', { label: 123 })).toBe(true);
    expect(select.props.filterOption('0', { label: 0 })).toBe(true);
    for (const label of [null, undefined, false, <span>Тест</span>, ['Тест']]) {
      expect(select.props.filterOption('тест', { label })).toBe(false);
    }
    expect(select.props.filterOption('тест', undefined)).toBe(false);
    expect(select.props.filterOption('', { label: 'Тест' })).toBe(true);
  });

  it.each([
    [false, 0], [undefined, 0], [{}, 0], [{ total: 0 }, 0], [{ total: 42 }, 42],
  ] as const)('shows the count for pagination %j', (pagination, expected) => {
    fixture.pagination = pagination;
    openFilters();
    act(() => tree.root.findByType('form').props.onSubmit({}));
    expect(JSON.stringify(tree.toJSON())).toContain(`Найдено записей: ","${expected}"`);
    expect(fixture.setFilters).toHaveBeenLastCalledWith([], 'replace');
  });

  it('preserves filter payload and clear behavior', () => {
    openFilters();
    act(() => tree.root.findByType('form').props.onSubmit({
      order_id: 7, created_by: 8, type_paid_id: 9, amount_min: 0, amount_max: 100,
      notes: 'Тест', date_range: [{ format: () => '2026-09-01' }, { format: () => '2026-09-19' }],
    }));
    expect(fixture.setFilters).toHaveBeenLastCalledWith([
      { field: 'order_id', operator: 'eq', value: 7 },
      { field: 'payment_date', operator: 'gte', value: '2026-09-01' },
      { field: 'payment_date', operator: 'lte', value: '2026-09-19' },
      { field: 'amount', operator: 'gte', value: 0 },
      { field: 'amount', operator: 'lte', value: 100 },
      { field: 'type_paid_id', operator: 'eq', value: 9 },
      { field: 'created_by', operator: 'eq', value: 8 },
      { field: 'notes', operator: 'contains', value: 'Тест' },
    ], 'replace');
    act(() => tree.root.findAllByType('button').find(button => button.children.includes('Сбросить'))!.props.onClick());
    expect(fixture.resetFields).toHaveBeenCalledOnce();
    expect(fixture.setFilters).toHaveBeenLastCalledWith([], 'replace');
    expect(JSON.stringify(tree.toJSON())).not.toContain('Найдено записей');
  });

  it('keeps the user filter and query permission-gated', () => {
    fixture.canViewUsers = false;
    const selects = openFilters();
    expect(selects.some(select => select.props.placeholder === 'Пользователь')).toBe(false);
    const userCalls = fixture.useSelect.mock.calls.map(([props]) => props).filter(props => props.resource === 'users');
    expect(userCalls.every(props => props.queryOptions.enabled === false)).toBe(true);
    act(() => tree.root.findByType('form').props.onSubmit({ created_by: 8 }));
    expect(fixture.setFilters).toHaveBeenLastCalledWith([], 'replace');
  });
});
