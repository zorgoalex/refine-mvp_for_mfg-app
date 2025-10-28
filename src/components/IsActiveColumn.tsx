import React from "react";
import { Table, Badge } from "antd";
import type { ColumnType } from "antd/es/table";

/**
 * JSX component wrapper for is_active column
 * Provides convenient <IsActiveColumn /> syntax for use inside <Table> children
 *
 * @param props - Optional overrides for column configuration
 * @returns Table.Column component with is_active configuration
 *
 * @example
 * // Basic usage inside Table
 * <Table {...tableProps} rowKey="id">
 *   <Table.Column dataIndex="id" title="ID" />
 *   <IsActiveColumn />
 *   <Table.Column dataIndex="name" title="Name" />
 * </Table>
 *
 * @example
 * // With custom width
 * <IsActiveColumn width={120} />
 */
export const IsActiveColumn: React.FC<Partial<ColumnType<any>>> = (props) => {
  return (
    <Table.Column
      dataIndex="is_active"
      title="Активен"
      sorter
      render={(value: boolean) => (
        <Badge
          status={value ? "success" : "default"}
          text={value ? "Активен" : "Неактивен"}
        />
      )}
      filters={[
        { text: "Активен", value: true },
        { text: "Неактивен", value: false },
      ]}
      {...props}
    />
  );
};
