import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceFilterBar } from './ReferenceFilterBar';
import type { RefineFilter, ReferenceFilterConfig } from './referenceFilterModel';

vi.mock('./referenceFilters.css', () => ({}));
vi.mock('@refinedev/antd', () => ({ useSelect: () => ({ selectProps: { options: [], onSearch: () => {} } }) }));
vi.mock('@ant-design/icons', () => ({
  ClearOutlined: () => null, DownOutlined: () => null, FilterOutlined: () => null, SearchOutlined: () => null,
}));
vi.mock('antd', () => ({
  Badge: () => null,
  Button: (props: any) => React.createElement('button', { type: 'button', onClick: props.onClick, className: props.className }, props.children),
  Checkbox: (props: any) => React.createElement('input', { type: 'checkbox', checked: props.checked, onChange: props.onChange, className: 'checkbox' }),
  Input: (props: any) => React.createElement('input', { value: props.value, onChange: props.onChange, 'aria-label': props['aria-label'], className: props.className }),
  InputNumber: () => null,
  Select: () => null,
}));

const config: ReferenceFilterConfig = {
  search: { field: 'name', placeholder: 'Поиск по названию' },
  activeField: true,
  fields: [{ kind: 'text', field: 'note', label: 'Примечание' }],
};

let renderer: ReactTestRenderer;
let filters: RefineFilter[] = [];

/** Refine stand-in: the bar sees the filters it set, as after a re-render of the list. */
const Host: React.FC = () => {
  const [state, setState] = React.useState<RefineFilter[]>([]);
  filters = state;
  return <ReferenceFilterBar storageKey="test" config={config} filters={state} setFilters={(next) => setState(next as RefineFilter[])} />;
};

const search = () => renderer.root.findByProps({ 'aria-label': 'Поиск по названию' });
const checkbox = () => renderer.root.findByProps({ className: 'checkbox' });
const resetButton = () => renderer.root.findByProps({ className: 'ref-filters__reset' });

describe('ReferenceFilterBar (mounted)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    filters = [];
    await act(async () => { renderer = create(<Host />); });
  });
  afterEach(() => {
    act(() => renderer.unmount());
    vi.useRealTimers();
  });

  it('a delayed search keeps «Показывать неактивные» chosen in the meantime', async () => {
    await act(async () => { search().props.onChange({ target: { value: 'дуб' } }); });
    await act(async () => { checkbox().props.onChange({ target: { checked: true } }); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(filters).toEqual([
      { field: 'is_active', operator: 'in', value: [true, false] },
      { field: 'name', operator: 'contains', value: 'дуб' },
    ]);
  });

  it('«Сбросить» drops the text still waiting to be applied', async () => {
    await act(async () => { checkbox().props.onChange({ target: { checked: true } }); });
    await act(async () => { search().props.onChange({ target: { value: 'дуб' } }); });
    await act(async () => { resetButton().props.onClick(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(filters).toEqual([]);
    expect(search().props.value).toBe('');
  });
});
