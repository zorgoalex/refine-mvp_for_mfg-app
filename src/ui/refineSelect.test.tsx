import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { Refine } from '@refinedev/core';
import { useSelect as nativeUseSelect } from '@refinedev/antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelect } from './refineSelect';

// Real React/Core/AntD hooks. Only the data-provider boundary is replaced.
const dataProvider = {
  getList: vi.fn(),
  getMany: vi.fn(),
  getOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteOne: vi.fn(),
  getApiUrl: () => 'http://unused.test',
};
let latest: ReturnType<typeof useSelect>;
let renderer: ReactTestRenderer | undefined;
let queryClient: QueryClient;

function Harness({ selectOptions }: { selectOptions: Parameters<typeof useSelect>[0] }) {
  latest = useSelect(selectOptions);
  return null;
}

async function mount(selectOptions: Parameters<typeof useSelect>[0]) {
  await act(async () => {
    renderer = create(
      <Refine
        dataProvider={dataProvider}
        resources={[{ name: 'clients' }]}
        options={{ disableTelemetry: true, reactQuery: { clientConfig: queryClient } }}
      >
        <Harness selectOptions={selectOptions} />
      </Refine>,
    );
  });
}

describe('Refine Select native runtime contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    dataProvider.getList.mockResolvedValue({ data: [{ id: 1, title: 'Тест: другой клиент' }], total: 1 });
    dataProvider.getMany.mockResolvedValue({ data: [{ id: 7, title: 'Тест: выбранный клиент' }] });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = undefined;
    queryClient.clear();
    expect(dataProvider.create).not.toHaveBeenCalled();
    expect(dataProvider.update).not.toHaveBeenCalled();
    expect(dataProvider.deleteOne).not.toHaveBeenCalled();
  });

  it('exports the exact native hook object', () => {
    expect(useSelect).toBe(nativeUseSelect);
  });

  it('keeps selected/default lookup, native loading and the actual five select props', async () => {
    let resolveLookup!: (value: { data: { id: number; title: string }[] }) => void;
    dataProvider.getMany.mockReturnValue(new Promise(resolve => { resolveLookup = resolve; }));
    const props = { resource: 'clients', defaultValue: 7, debounce: 0 };
    const input = structuredClone(props);
    await mount(props);
    await vi.waitFor(() => expect(dataProvider.getMany).toHaveBeenCalledOnce());
    expect(dataProvider.getMany.mock.calls[0][0]).toMatchObject({ resource: 'clients', ids: [7] });
    expect(latest.selectProps.loading).toBe(true);
    expect(latest.defaultValueQueryResult.isFetching).toBe(true);
    expect(Object.keys(latest).sort()).toEqual(['defaultValueQueryResult', 'queryResult', 'selectProps']);
    expect(Object.keys(latest.selectProps).sort()).toEqual(['filterOption', 'loading', 'onSearch', 'options', 'showSearch']);
    expect(latest.selectProps.showSearch).toBe(true);
    expect(latest.selectProps.filterOption).toBe(false);

    await act(async () => resolveLookup({ data: [{ id: 7, title: 'Тест: выбранный клиент' }] }));
    await vi.waitFor(() => expect(latest.selectProps.loading).toBe(false));
    expect(latest.defaultValueQueryResult.data?.data).toEqual([{ id: 7, title: 'Тест: выбранный клиент' }]);
    expect(latest.queryResult.data?.data).toEqual([{ id: 1, title: 'Тест: другой клиент' }]);
    expect(latest.selectProps.options).toEqual(expect.arrayContaining([
      { value: 7, label: 'Тест: выбранный клиент' },
      { value: 1, label: 'Тест: другой клиент' },
    ]));
    expect(props).toEqual(input);
  });

  it('preserves search and string default keys without coercion', async () => {
    dataProvider.getMany.mockResolvedValue({ data: [{ id: '7', title: 'Тест: строковый клиент' }] });
    await mount({ resource: 'clients', defaultValue: '7', debounce: 0 });
    await vi.waitFor(() => expect(latest.selectProps.options).toContainEqual({ value: '7', label: 'Тест: строковый клиент' }));
    expect(dataProvider.getMany.mock.calls[0][0].ids).toEqual(['7']);
    act(() => latest.selectProps.onSearch?.('Тест: поиск'));
    await vi.waitFor(() => expect(dataProvider.getList).toHaveBeenLastCalledWith(expect.objectContaining({
      resource: 'clients',
      filters: [{ field: 'title', operator: 'contains', value: 'Тест: поиск' }],
    })));
  });

  it('respects disabled list and default-value queries', async () => {
    await mount({
      resource: 'clients', defaultValue: 7,
      queryOptions: { enabled: false }, defaultValueQueryOptions: { enabled: false },
    });
    expect(dataProvider.getList).not.toHaveBeenCalled();
    expect(dataProvider.getMany).not.toHaveBeenCalled();
    expect(latest.queryResult.isFetching).toBe(false);
    expect(latest.defaultValueQueryResult.isFetching).toBe(false);
    expect(latest.selectProps.loading).toBe(false);
  });
});
