import type { ColumnsType, TableProps } from 'antd/es/table';

/** Group columns do not have a data index; leaf array indexes stay unchanged. */
export function getTableColumnDataIndex<RecordType>(column: ColumnsType<RecordType>[number]) {
  return 'dataIndex' in column ? column.dataIndex : undefined;
}

/** Native Table accepts boolean sticky as well as the offset configuration. */
export function getTableStickyOffsetHeader(sticky: TableProps<unknown>['sticky']) {
  return typeof sticky === 'object' ? sticky?.offsetHeader : undefined;
}
