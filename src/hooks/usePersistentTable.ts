import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useTable as useRefineTable,
  type useTableProps,
  type useTableReturnType,
} from '@refinedev/antd';
import {
  useResource,
  type BaseRecord,
  type HttpError,
} from '@refinedev/core';
import { Grid, type TableProps } from 'antd';

import {
  DEFAULT_PAGE_SIZE,
  normalizePageSize,
  PAGE_SIZE_OPTIONS,
  usePageSizePreference,
} from './usePageSizePreference';

type PersistentTableProps<TData, TError, TSearchVariables> =
  useTableProps<TData, TError, TSearchVariables> & {
    pageSizePreferenceKey?: string;
  };

export const usePersistentTable = <
  TData extends BaseRecord = BaseRecord,
  TError extends HttpError = HttpError,
  TSearchVariables = unknown,
>(props: PersistentTableProps<TData, TError, TSearchVariables> = {}): useTableReturnType<
  TData,
  TError,
  TSearchVariables
> => {
  const { pageSizePreferenceKey, ...tableOptions } = props;
  const { identifier } = useResource(tableOptions.resource);
  const preferenceKey = pageSizePreferenceKey ?? `refine:${identifier ?? tableOptions.resource ?? 'list'}`;
  const defaultPageSize = normalizePageSize(
    tableOptions.pagination?.pageSize ?? tableOptions.initialPageSize,
  ) ?? DEFAULT_PAGE_SIZE;
  const paginationEnabled = tableOptions.hasPagination !== false && tableOptions.pagination?.mode !== 'off';
  const { pageSize: preferredPageSize, setPageSize: rememberPageSize } = usePageSizePreference(
    preferenceKey,
    defaultPageSize,
  );
  const breakpoint = Grid.useBreakpoint();

  const result = useRefineTable<TData, TError, TSearchVariables>({
    ...tableOptions,
    ...(paginationEnabled
      ? {
          initialPageSize: preferredPageSize,
          pagination: {
            ...tableOptions.pagination,
            pageSize: preferredPageSize,
          },
        }
      : {}),
  });
  const lastAppliedPreference = useRef(preferredPageSize);

  useEffect(() => {
    if (!paginationEnabled || lastAppliedPreference.current === preferredPageSize) return;
    lastAppliedPreference.current = preferredPageSize;
    if (result.pageSize !== preferredPageSize) {
      result.setPageSize(preferredPageSize);
      result.setCurrent(1);
    }
  }, [paginationEnabled, preferredPageSize, result.pageSize, result.setCurrent, result.setPageSize]);

  const persistentSetPageSize = useCallback((nextPageSize: number) => {
    const normalized = normalizePageSize(nextPageSize);
    if (!normalized) return;
    rememberPageSize(normalized);
    result.setPageSize(normalized);
    result.setCurrent(1);
  }, [rememberPageSize, result.setCurrent, result.setPageSize]);

  const onChange = useCallback<NonNullable<TableProps<TData>['onChange']>>((pagination, filters, sorter, extra) => {
    const nextPageSize = normalizePageSize(pagination.pageSize);
    const pageSizeChanged = nextPageSize !== null && nextPageSize !== result.pageSize;
    if (pageSizeChanged) rememberPageSize(nextPageSize);
    result.tableProps.onChange?.(
      pageSizeChanged ? { ...pagination, current: 1 } : pagination,
      filters,
      sorter,
      extra,
    );
  }, [rememberPageSize, result.pageSize, result.tableProps]);

  const tableProps = useMemo<TableProps<TData>>(() => ({
    ...result.tableProps,
    onChange,
    pagination: result.tableProps.pagination === false
      ? false
      : {
          ...result.tableProps.pagination,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          showSizeChanger: true,
          simple: false,
          showLessItems: !breakpoint.sm || result.tableProps.pagination?.showLessItems,
        },
  }), [breakpoint.sm, onChange, result.tableProps]);

  return {
    ...result,
    tableProps,
    setPageSize: persistentSetPageSize,
  };
};

export { usePersistentTable as useTable };
