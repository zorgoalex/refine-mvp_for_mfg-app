import { describe, expect, it } from "vitest";

import { buildOrderListFilterFormSync } from "./orderListFilterFormSync";

describe("orderListFilterFormSync", () => {
  it("hydrates backend order list filters back into filter form values", () => {
    const result = buildOrderListFilterFormSync(
      [
        { field: "order_name", operator: "contains", value: "2704" },
        { field: "order_date", operator: "gte", value: "2026-07-01" },
        { field: "order_date", operator: "lte", value: "2026-07-28" },
        { field: "client_id", operator: "eq", value: "12" },
        { field: "created_by", operator: "eq", value: "7" },
        { field: "order_status_id", operator: "eq", value: "3" },
        { field: "payment_status_id", operator: "eq", value: "4" },
        { field: "final_amount", operator: "gte", value: "1000" },
        { field: "final_amount", operator: "lte", value: "5000" },
        { field: "paid_amount", operator: "gte", value: "100" },
        { field: "paid_amount", operator: "lte", value: "900" },
        { field: "doweling_order_name", operator: "eq", value: "D-1" },
        { field: "group_ids", operator: "in", value: [10, "20"] },
        { field: "group_mode", operator: "eq", value: "all" },
      ],
      { useBackendOrdersRead: true, canViewUsers: true },
    );

    expect(result.hasActiveFilters).toBe(true);
    expect(result.groupMode).toBe("all");
    expect(result.values).toMatchObject({
      order_name: "2704",
      client_id: 12,
      created_by: 7,
      order_status_name: 3,
      payment_status_name: 4,
      final_amount_min: 1000,
      final_amount_max: 5000,
      paid_amount_min: 100,
      paid_amount_max: 900,
      doweling_order_name: "D-1",
      group_ids: ["10", "20"],
      group_mode: "all",
    });
    expect(result.values.order_date_range?.[0].format("YYYY-MM-DD")).toBe("2026-07-01");
    expect(result.values.order_date_range?.[1].format("YYYY-MM-DD")).toBe("2026-07-28");
  });

  it("returns empty form defaults when no active filters exist", () => {
    const result = buildOrderListFilterFormSync(
      [
        { field: "order_name", operator: "contains", value: "" },
        { field: "group_ids", operator: "in", value: [] },
      ],
      { useBackendOrdersRead: false, canViewUsers: false },
    );

    expect(result.hasActiveFilters).toBe(false);
    expect(result.groupMode).toBe("any");
    expect(result.values).toMatchObject({
      order_name: undefined,
      order_date_range: null,
      client_id: undefined,
      created_by: undefined,
      order_status_name: undefined,
      payment_status_name: undefined,
      final_amount_min: undefined,
      final_amount_max: undefined,
      paid_amount_min: undefined,
      paid_amount_max: undefined,
      doweling_order_name: undefined,
      group_ids: [],
      group_mode: "any",
    });
  });

  it("keeps created_by for My Orders sync even without users lookup access", () => {
    const result = buildOrderListFilterFormSync(
      [{ field: "created_by", operator: "eq", value: "17" }],
      { useBackendOrdersRead: true, canViewUsers: false },
    );

    expect(result.hasActiveFilters).toBe(true);
    expect(result.values.created_by).toBe(17);
  });
});
