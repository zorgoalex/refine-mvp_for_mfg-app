import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MdfProductionReturnController,
  mdfReturnConfirmSchema,
  mdfReturnRequestSchema,
} from "./mdf-production-return.controller";
import type { DatabaseService } from "../../../database/database.service";
import type { OrdersRuntimeConfigService } from "./orders-runtime-config.service";
import type { RequestWithCurrentUser } from "../../../permissions/current-user";
const calls = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn() }));
vi.mock("../adapters/pg-mdf-production-return", () => ({
  PgMdfProductionReturn: class {
    preview = calls.preview;
    confirm = calls.confirm;
  },
}));
describe("MDF production return HTTP contract", () => {
  beforeEach(() => {
    calls.preview.mockReset();
    calls.confirm.mockReset();
  });
  const packet = "00000000-0000-0000-0000-000000000101";
  const req = {
    user: { id: "1", role: "admin", permissions: [] },
    requestId: "E2E-return",
  } as unknown as RequestWithCurrentUser;
  const controller = (enabled = true, readOnly = false) =>
    new MdfProductionReturnController(
      {} as DatabaseService,
      {
        getFeatureFlags: () => ({
          ordersEnabled: enabled,
          ordersReadOnly: readOnly,
        }),
      } as OrdersRuntimeConfigService
    );
  it("requires auth and obeys feature/read-only flags before calling command", () => {
    expect(() =>
      controller().preview({} as RequestWithCurrentUser, "packet", packet, {
        targetColumn: "parsed",
      })
    ).toThrow("Authentication required");
    expect(() =>
      controller(false).preview(req, "packet", packet, {
        targetColumn: "parsed",
      })
    ).toThrow("недоступны");
    expect(() =>
      controller(true, true).confirm(req, "packet", packet, {})
    ).toThrow("недоступны");
    expect(calls.preview).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
  });
  it("rejects arbitrary detail IDs, reason fields, invalid windows and malformed sources", () => {
    expect(
      mdfReturnRequestSchema.safeParse({
        targetColumn: "parsed",
        detailIds: [1],
      }).success
    ).toBe(false);
    expect(
      mdfReturnRequestSchema.safeParse({
        targetColumn: "parsed",
        reason: "required?",
      }).success
    ).toBe(false);
    expect(
      mdfReturnRequestSchema.safeParse({
        targetColumn: "parsed",
        boardWindow: { dateFrom: "2026-09-12", dateTo: "2026-09-11" },
      }).success
    ).toBe(false);
    expect(() =>
      controller().preview(req, "packet", "arbitrary", {
        targetColumn: "parsed",
      })
    ).toThrow();
    expect(() =>
      controller().preview(req, "bath", "101", { targetColumn: "baths" })
    ).toThrow();
  });
  it("passes authenticated actor, exact identity and confirmation key through unchanged", () => {
    const body = {
      targetColumn: "parsed" as const,
      productionStatusId: 1,
      expectedDigest: "a".repeat(64),
      idempotencyKey: "E2E-key-123",
    };
    expect(mdfReturnConfirmSchema.safeParse(body).success).toBe(true);
    controller().confirm(req, "packet", packet, body);
    expect(calls.confirm).toHaveBeenCalledWith(
      req.user,
      { kind: "packet", id: packet },
      body,
      "E2E-return"
    );
  });
});
