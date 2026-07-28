import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

export type OrderListGroupMode = "any" | "all" | "primary" | "none";

export interface OrderListFilterRow {
  field?: string;
  operator?: string;
  value?: unknown;
}

export interface OrderListFilterFormValues {
  order_name: string | undefined;
  order_date_range: [Dayjs, Dayjs] | null;
  client_id: number | undefined;
  created_by: number | undefined;
  order_status_name: string | number | undefined;
  payment_status_name: string | number | undefined;
  final_amount_min: number | undefined;
  final_amount_max: number | undefined;
  paid_amount_min: number | undefined;
  paid_amount_max: number | undefined;
  doweling_order_name: string | undefined;
  group_ids: string[];
  group_mode: OrderListGroupMode;
}

export interface OrderListFilterFormSyncResult {
  values: OrderListFilterFormValues;
  groupMode: OrderListGroupMode;
  hasActiveFilters: boolean;
}

export function buildOrderListFilterFormSync(
  filters: readonly OrderListFilterRow[] | undefined,
  options: { useBackendOrdersRead: boolean; canViewUsers: boolean },
): OrderListFilterFormSyncResult {
  const rows = (filters ?? []).filter(isActiveFilterRow);
  const orderStatusField = options.useBackendOrdersRead ? "order_status_id" : "order_status_name";
  const paymentStatusField = options.useBackendOrdersRead ? "payment_status_id" : "payment_status_name";
  const groupMode = normalizeGroupMode(readFilterValue(rows, "group_mode")) ?? "any";
  const dateFrom = toDayjsOrNull(readFilterValue(rows, "order_date", "gte"));
  const dateTo = toDayjsOrNull(readFilterValue(rows, "order_date", "lte"));

  const values: OrderListFilterFormValues = {
    order_name: toOptionalString(readFilterValue(rows, "order_name")),
    order_date_range: dateFrom && dateTo ? [dateFrom, dateTo] : null,
    client_id: toOptionalNumber(readFilterValue(rows, "client_id", "eq")),
    created_by: toOptionalNumber(readFilterValue(rows, "created_by", "eq")),
    order_status_name: options.useBackendOrdersRead
      ? toOptionalNumber(readFilterValue(rows, orderStatusField, "eq"))
      : toOptionalString(readFilterValue(rows, orderStatusField, "eq")),
    payment_status_name: options.useBackendOrdersRead
      ? toOptionalNumber(readFilterValue(rows, paymentStatusField, "eq"))
      : toOptionalString(readFilterValue(rows, paymentStatusField, "eq")),
    final_amount_min: toOptionalNumber(readFilterValue(rows, "final_amount", "gte")),
    final_amount_max: toOptionalNumber(readFilterValue(rows, "final_amount", "lte")),
    paid_amount_min: toOptionalNumber(readFilterValue(rows, "paid_amount", "gte")),
    paid_amount_max: toOptionalNumber(readFilterValue(rows, "paid_amount", "lte")),
    doweling_order_name: toOptionalString(readFilterValue(rows, "doweling_order_name", "eq")),
    group_ids: toStringArray(readFilterValue(rows, "group_ids", "in")),
    group_mode: groupMode,
  };

  return {
    values,
    groupMode,
    hasActiveFilters: rows.length > 0,
  };
}

function readFilterValue(
  filters: readonly OrderListFilterRow[],
  field: string,
  operator?: string,
): unknown {
  return filters.find((filter) => (
    filter.field === field && (!operator || filter.operator === operator)
  ))?.value;
}

function isActiveFilterRow(filter: OrderListFilterRow): boolean {
  if (!filter.field) return false;
  const value = filter.value;
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toDayjsOrNull(value: unknown): Dayjs | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = dayjs(String(value));
  return parsed.isValid() ? parsed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item !== undefined && item !== null && item !== "")
    .map(String);
}

function normalizeGroupMode(value: unknown): OrderListGroupMode | null {
  return value === "any" || value === "all" || value === "primary" || value === "none"
    ? value
    : null;
}
