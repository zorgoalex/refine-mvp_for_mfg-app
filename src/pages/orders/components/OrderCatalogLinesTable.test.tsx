import React from 'react';
import { create, act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrderCatalogLinesTable } from './OrderCatalogLinesTable';
import { catalogApi } from '../../../api/catalogApi';

vi.mock('../../../api/catalogApi', () => ({ catalogApi: { list: vi.fn() } }));
vi.mock('@ant-design/icons', () => ({ DeleteOutlined: () => null }));
vi.mock('antd', () => {
  const component = (tag: string) => ({ children, ...props }: any) => React.createElement(tag, props, children);
  const Input = Object.assign(component('input'), { TextArea: component('textarea') });
  return { Alert: component('alert'), Button: component('button'), Empty: Object.assign(component('empty'), { PRESENTED_IMAGE_SIMPLE: '' }),
    Input, Pagination: component('pagination'), Popconfirm: component('popconfirm'), Select: component('select'), Space: component('space'),
    Table: component('table'), Tag: component('tag'), Typography: { Text: component('text') } };
});

describe('order catalogue table draft editing', () => {
  let view: ReturnType<typeof create>;
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(catalogApi.list).mockReset(); });
  afterEach(() => { act(() => view?.unmount()); vi.useRealTimers(); });
  const item = { id: 5, version: 2, name: 'Доставка', kind: 'service', unitId: 1, unitName: 'шт', sku: null, refKey1c: null, basePrice: '1500.50' };
  it('loads paged catalogue, captures defaults and edits draft without API writes', async () => {
    vi.mocked(catalogApi.list).mockResolvedValue({ items: [item], total: 26 } as any);
    const onChange = vi.fn();
    act(() => { view = create(<OrderCatalogLinesTable rows={[]} onChange={onChange} canSelect canViewFinancials />); });
    await act(async () => { view.root.findByType('select').props.onDropdownVisibleChange(true); });
    expect(catalogApi.list).toHaveBeenCalledWith({ q: '', active: 'true', offset: 0, limit: 25 });
    const popup = view.root.findByType('select').props.dropdownRender(null);
    await act(async () => popup.props.children[1].props.onChange(2));
    expect(catalogApi.list).toHaveBeenLastCalledWith({ q: '', active: 'true', offset: 25, limit: 25 });
    act(() => view.root.findByType('select').props.onSelect(5));
    const row = onChange.mock.calls[0][0][0];
    expect(row).toMatchObject({ catalogItemId: 5, catalogVersion: 2, quantity: '1', unitPrice: '1500.50', kind: 'service', unitName: 'шт' });
    act(() => view.update(<OrderCatalogLinesTable rows={[{ ...row, id: 7 }]} onChange={onChange} canSelect canViewFinancials />));
    const columns = view.root.findByType('table').props.columns;
    act(() => columns.find((c: any) => c.title === 'Цена, ₸').render(null, row, 0).props.onChange({ target: { value: '2500,75' } }));
    expect(onChange.mock.lastCall?.[0][0].unitPrice).toBe('2500.75');
    act(() => columns.at(-1).render(null, { ...row, id: 7 }, 0).props.onConfirm());
    expect(onChange).toHaveBeenLastCalledWith([], [7]);
  });
  it('keeps empty price required and never shows money/edit controls in readonly redacted view', async () => {
    vi.mocked(catalogApi.list).mockResolvedValue({ items: [{ ...item, basePrice: null }], total: 1 } as any);
    const onChange = vi.fn();
    act(() => { view = create(<OrderCatalogLinesTable rows={[]} onChange={onChange} canSelect canViewFinancials />); });
    await act(async () => view.root.findByType('select').props.onDropdownVisibleChange(true));
    act(() => view.root.findByType('select').props.onSelect(5));
    const rows = onChange.mock.calls[0][0];
    expect(rows[0].unitPrice).toBe('');
    act(() => view.update(<OrderCatalogLinesTable rows={rows} canViewFinancials={false} />));
    expect(view.root.findAllByType('select')).toHaveLength(0);
    expect(view.root.findByType('table').props.columns.map((c: any) => c.title)).not.toContain('Цена, ₸');
    expect(view.root.findByType('table').props.footer).toBeUndefined();
  });
});
