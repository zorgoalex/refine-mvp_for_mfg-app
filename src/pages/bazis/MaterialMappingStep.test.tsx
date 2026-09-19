import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ enabled: true, error: null as { message: string } | null, useList: vi.fn() }));
const references = {
  sheetMaterialTypes: [
    { value: 2, label: 'Тест лист 2', sortOrder: 20, isCuttable: true },
    { value: 1, label: 'Тест лист 1', sortOrder: 10, isCuttable: true },
    { value: 9, label: 'Тест недоступный', sortOrder: 0, isCuttable: false },
  ],
  films: [{ value: 3, label: 'Тест плёнки', sortOrder: 30 }],
  edgeTypes: [{ value: 4, label: 'Тест кромки', sortOrder: 40 }],
};
vi.mock('../../hooks/useOrderFormData', () => ({
  useOrderFormData: () => ({ enabled: fixture.enabled, error: fixture.error, references }),
  createBackendSelectProps: vi.fn(),
}));
vi.mock('@refinedev/core', () => ({ useList: (props: any) => {
  fixture.useList(props);
  const data = props.resource === 'sheet_material_types'
    ? references.sheetMaterialTypes.map(item => ({ sheet_material_type_id: item.value, name: item.label, is_cuttable: item.isCuttable }))
    : props.resource === 'films'
      ? references.films.map(item => ({ film_id: item.value, film_name: item.label }))
      : references.edgeTypes.map(item => ({ edge_type_id: item.value, edge_type_name: item.label }));
  return { data: { data } };
} }));
vi.mock('../../ui/tooltipDelay', () => ({ Table: ({ columns, dataSource }: any) => <>{dataSource.map((row: any) => (
  <div key={`${row.kindGuess}:${row.name}`}>{columns.find((column: any) => column.key === 'target').render(undefined, row)}</div>
))}</> }));
vi.mock('antd', () => ({
  Alert: (props: any) => React.createElement('test-alert', props),
  Select: (props: any) => React.createElement('test-select', props),
  Space: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Typography: { Text: ({ children }: React.PropsWithChildren) => <span>{children}</span> },
}));
import { MaterialMappingStep } from './MaterialMappingStep';

let tree: ReactTestRenderer;
const items = ['sheet', 'film', 'edge'].map(kindGuess => ({ name: 'Тест', kindGuess, usageCount: 1 }));
beforeEach(() => { vi.clearAllMocks(); fixture.enabled = true; fixture.error = null; });
afterEach(() => { if (tree) act(() => tree.unmount()); });

describe.each([true, false])('material options backend=%s', enabled => {
  it('preserves labels, IDs, filtering and source order without inventing sortOrder', () => {
    fixture.enabled = enabled;
    const before = JSON.stringify(references);
    act(() => { tree = create(<MaterialMappingStep items={items} values={{}} onChange={vi.fn()} />); });
    const selects = tree.root.findAllByType('test-select');
    expect(selects[0].props.options).toEqual([
      { value: 'ignore', label: 'Пропустить' },
      { value: 2, label: 'Тест лист 2' }, { value: 1, label: 'Тест лист 1' },
    ]);
    expect(selects[1].props.options.map(({ value, label }: any) => ({ value, label }))).toEqual([
      { value: 'ignore', label: 'Пропустить' }, { value: 3, label: 'Тест плёнки' },
    ]);
    expect(selects[2].props.options.map(({ value, label }: any) => ({ value, label }))).toEqual([
      { value: 'ignore', label: 'Пропустить' }, { value: 4, label: 'Тест кромки' },
    ]);
    expect(selects.every(select => select.props.optionFilterProp === 'label')).toBe(true);
    expect(fixture.useList.mock.calls.every(([props]) => props.queryOptions.enabled === !enabled)).toBe(true);
    expect(JSON.stringify(references)).toBe(before);
  });

  it('keeps mapping contexts independent and preserves selected/ignore values', () => {
    fixture.enabled = enabled;
    const onChange = vi.fn();
    act(() => { tree = create(<MaterialMappingStep items={items} values={{
      'sheet:тест': { targetKind: 'sheet', targetId: 2 },
      'film:тест': { targetKind: 'ignore', targetId: null },
    }} onChange={onChange} />); });
    const selects = tree.root.findAllByType('test-select');
    expect(selects.map(select => select.props.value)).toEqual([2, 'ignore', undefined]);
    act(() => selects[0].props.onChange('1'));
    act(() => selects[1].props.onChange('ignore'));
    act(() => selects[2].props.onChange(4));
    expect(onChange.mock.calls).toEqual([
      ['sheet:тест', { targetKind: 'sheet', targetId: 1 }],
      ['film:тест', { targetKind: 'ignore', targetId: null }],
      ['edge:тест', { targetKind: 'edge', targetId: 4 }],
    ]);
  });
});

it('retains the backend reference error boundary', () => {
  fixture.error = { message: 'Тест ошибки справочников' };
  act(() => { tree = create(<MaterialMappingStep items={items} values={{}} onChange={vi.fn()} />); });
  expect(tree.root.findByType('test-alert').props.message).toBe(fixture.error.message);
  expect(tree.root.findAllByType('test-select')).toHaveLength(0);
});
