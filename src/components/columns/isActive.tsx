import { Badge } from "antd";
import type { ColumnType } from "antd/es/table";

/**
 * Factory function for creating is_active column definition
 * Centralizes labels, filters, and rendering logic for is_active field
 *
 * @param overrides - Optional overrides for column configuration (width, fixed, etc.)
 * @returns Column definition object for AntD Table
 *
 * @example
 * // Basic usage
 * const columns = [
 *   { dataIndex: 'id', title: 'ID' },
 *   isActiveColumn(),
 *   { dataIndex: 'name', title: 'Name' },
 * ];
 *
 * @example
 * // With overrides
 * const columns = [
 *   isActiveColumn({ width: 120, fixed: 'right' }),
 * ];
 */
export const isActiveColumn = <T extends Record<string, any>>(
  overrides?: Partial<ColumnType<T>>
): ColumnType<T> => ({
  dataIndex: "is_active",
  title: "Активен",
  sorter: true,
  render: (value: boolean) => (
    <Badge
      status={value ? "success" : "default"}
      text={value ? "Активен" : "Неактивен"}
    />
  ),
  filters: [
    { text: "Активен", value: true },
    { text: "Неактивен", value: false },
  ],
  ...overrides,
});
