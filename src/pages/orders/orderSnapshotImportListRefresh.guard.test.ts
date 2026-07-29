import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const listSource = readFileSync(new URL("./list.tsx", import.meta.url), "utf8");

describe("order snapshot import list refresh guard", () => {
  it("refreshes the orders list after JSON snapshot import without page reload", () => {
    expect(listSource).toContain("useInvalidate");
    expect(listSource).toContain("tableQueryResult");
    expect(listSource).toContain('await invalidate({ resource: "orders_view", invalidates: ["list"] })');
    expect(listSource).toContain("await tableQueryResult.refetch()");
  });
});
