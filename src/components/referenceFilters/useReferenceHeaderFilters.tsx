// Column header filters of the reference lists: a multi-select of the column's distinct values (up to
// HEADER_FILTER_MAX_VALUES; a column with more values gets no filter). The values come from Hasura under the other
// filters of the list (cascading), the choice is the Refine `in` filter of the field (server-side, in the URL).
import React, { useMemo, useState } from 'react';
import { Button, Checkbox, Input, Spin, Typography } from 'antd';
import { FilterFilled, SearchOutlined } from '@ant-design/icons';
import type { FilterDropdownProps } from 'antd/es/table/interface';
import type { TableProps } from 'antd';
import { useDataProvider, type CrudFilters } from '@refinedev/core';
import { useQueries } from '@tanstack/react-query';
import {
  HEADER_FILTER_MAX_VALUES,
  defaultHeaderLabel,
  filtersWithoutHeader,
  headerFilterKeys,
  headerFilterOptions,
  valuesForKeys,
  withHeaderFilter,
  type HeaderFilterOption,
  type HeaderFilterValue,
} from './headerFilterModel';

/** A foreign key column: the option labels are the names from the referenced resource. */
export interface HeaderFilterLookup {
  resource: string;
  optionValue: string;
  optionLabel: string;
}

export interface ReferenceHeaderFiltersConfig {
  resource: string;
  /** Columns that may get a header filter (scalar fields of the resource). */
  fields: readonly string[];
  lookups?: Readonly<Record<string, HeaderFilterLookup>>;
  /** Labels of plain values (enums); booleans are «Да / Нет» by default. */
  labels?: Readonly<Record<string, (value: HeaderFilterValue) => string>>;
}

type TableLike = {
  tableProps: TableProps<any>;
  filters: CrudFilters;
  setFilters: (filters: CrudFilters, behavior?: 'merge' | 'replace') => void;
  setCurrent: (page: number) => void;
};

const STALE_MS = 60_000;

export function useReferenceHeaderFilters(table: TableLike, config: ReferenceHeaderFiltersConfig) {
  const dataProvider = useDataProvider()();
  const { resource, fields, lookups, labels } = config;
  const filters = table.filters as any[];

  const distinctQueries = useQueries({
    queries: fields.map((field) => {
      const base = filtersWithoutHeader(filters, field);
      return {
        queryKey: ['reference-header-filter', resource, field, base],
        staleTime: STALE_MS,
        queryFn: async () => (await dataProvider.getList({
          resource,
          filters: base as CrudFilters,
          pagination: { current: 1, pageSize: HEADER_FILTER_MAX_VALUES + 1 },
          meta: { distinctOn: field },
        })).data as Record<string, unknown>[],
      };
    }),
  });

  const lookupFields = fields.filter((field) => lookups?.[field]);
  const lookupQueries = useQueries({
    queries: lookupFields.map((field) => {
      const lookup = lookups![field];
      const rows = distinctQueries[fields.indexOf(field)]?.data;
      const ids = (rows ?? []).map((row) => row[field]).filter((id) => id !== null && id !== undefined);
      return {
        queryKey: ['reference-header-filter-lookup', lookup.resource, lookup.optionValue, ids],
        staleTime: STALE_MS,
        enabled: ids.length > 0 && ids.length <= HEADER_FILTER_MAX_VALUES,
        queryFn: async () => (await dataProvider.getList({
          resource: lookup.resource,
          filters: [
            { field: lookup.optionValue, operator: 'in', value: ids },
            // Inactive referenced records keep their names (the auto `is_active = true` filter is lifted).
            { field: 'is_active', operator: 'in', value: [true, false] },
          ] as CrudFilters,
          pagination: { mode: 'off' },
        })).data as Record<string, unknown>[],
      };
    }),
  });

  const optionsByField = useMemo(() => {
    const result: Record<string, { options: HeaderFilterOption[] | undefined; loading: boolean; failed: boolean }> = {};
    fields.forEach((field, index) => {
      const query = distinctQueries[index];
      let label = labels?.[field] ?? defaultHeaderLabel;
      const lookup = lookups?.[field];
      if (lookup) {
        const names = new Map<string, string>();
        (lookupQueries[lookupFields.indexOf(field)]?.data ?? []).forEach((row) => {
          names.set(String(row[lookup.optionValue]), String(row[lookup.optionLabel] ?? row[lookup.optionValue]));
        });
        label = (value) => names.get(String(value)) ?? String(value);
      }
      result[field] = {
        options: query?.isError ? undefined : headerFilterOptions(query?.data, field, label),
        loading: Boolean(query?.isLoading),
        failed: Boolean(query?.isError),
      };
    });
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, distinctQueries.map((q) => `${q.status}:${q.dataUpdatedAt}`).join(), lookupQueries.map((q) => `${q.status}:${q.dataUpdatedAt}`).join(), labels, lookups]);

  const apply = (field: string, keys: string[]) => {
    const options = optionsByField[field]?.options ?? [];
    table.setFilters(withHeaderFilter(filters, field, valuesForKeys(keys, options)) as CrudFilters, 'replace');
    table.setCurrent(1);
  };

  /** Props for a `Table.Column` of `field`: the header filter, or nothing when the column has too many values. */
  const columnFilter = (field: string): Record<string, unknown> => {
    const selected = headerFilterKeys(filters, field);
    const state = optionsByField[field];
    if (!state || (state.options === undefined && selected.length === 0)) return {};
    return {
      filteredValue: selected,
      filterIcon: (filtered: boolean) => <FilterFilled style={{ color: filtered ? '#1677ff' : undefined }} />,
      filterDropdown: (props: FilterDropdownProps) => (
        <HeaderFilterDropdown
          {...props}
          options={state.options}
          loading={state.loading}
          failed={state.failed}
          selected={selected}
          onApply={(keys) => apply(field, keys)}
        />
      ),
    };
  };

  // The header filters go to Refine here, not through the antd table `onChange` (Refine would map them with the
  // operator of another filter of the same field, e.g. the panel's «eq»).
  const tableProps = useMemo<TableProps<any>>(() => ({
    ...table.tableProps,
    onChange: (pagination, _filters, sorter, extra) => table.tableProps.onChange?.(pagination, {}, sorter, extra),
  }), [table.tableProps]);

  return { tableProps, columnFilter };
}

const HeaderFilterDropdown: React.FC<FilterDropdownProps & {
  options: HeaderFilterOption[] | undefined;
  loading: boolean;
  failed: boolean;
  selected: string[];
  onApply: (keys: string[]) => void;
}> = ({ options, loading, failed, selected, onApply, close }) => {
  const [search, setSearch] = useState('');
  // A chosen value the other filters now hide stays in the list, so it can be unchecked.
  const all = useMemo(() => {
    const list = [...(options ?? [])];
    const known = new Set(list.map((option) => option.key));
    selected.filter((key) => !known.has(key)).forEach((key) => list.push({ key, value: key, label: key }));
    return list;
  }, [options, selected]);
  const needle = search.trim().toLowerCase();
  const visible = needle ? all.filter((option) => option.label.toLowerCase().includes(needle)) : all;

  // The choice goes straight to the Refine filters (no antd `confirm`: the table `onChange` would also reset paging).
  const set = (keys: string[]) => onApply(keys);

  return (
    <div className="reference-header-filter" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, width: 260 }}>
      {all.length > 8 ? (
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Найти значение"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {loading ? (
          <Spin size="small" />
        ) : failed && all.length === 0 ? (
          <Typography.Text type="danger">Не удалось загрузить значения</Typography.Text>
        ) : options === undefined && all.length === 0 ? (
          <Typography.Text type="secondary">Слишком много значений — используйте поиск</Typography.Text>
        ) : visible.length === 0 ? (
          <Typography.Text type="secondary">Нет значений</Typography.Text>
        ) : (
          visible.map((option) => (
            <Checkbox
              key={option.key}
              checked={selected.includes(option.key)}
              onChange={(event) => set(event.target.checked
                ? [...selected, option.key]
                : selected.filter((key) => key !== option.key))}
            >
              <span style={{ whiteSpace: 'normal' }}>{option.label}</span>
            </Checkbox>
          ))
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <Button size="small" disabled={selected.length === 0} onClick={() => set([])}>Сбросить</Button>
        <Button size="small" type="primary" onClick={() => close()}>OK</Button>
      </div>
    </div>
  );
};
