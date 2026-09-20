import { describe, expect, it, vi } from "vitest";
import { WhatsAppTechnicalLogService } from "./whatsapp-technical-log.service";

const entry = {
  component: "waha" as const,
  level: "error" as const,
  eventCode: "waha.api.request",
  outcome: "failed" as const,
  operation: "GET /health",
};

describe("WhatsAppTechnicalLogService", () => {
  it("keeps database persistence out of the WAHA request critical path", async () => {
    let release: (() => void) | undefined;
    const query = vi.fn(() => new Promise((resolve) => {
      release = () => resolve({ rows: [], rowCount: 1 });
    }));
    const service = new WhatsAppTechnicalLogService({ query } as never);

    await expect(service.record(entry)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
    release?.();
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  });

  it("bounds stored text and never persists provider response bodies", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const service = new WhatsAppTechnicalLogService({ query } as never);
    await service.record({
      ...entry,
      errorMessage: `Error\n${"x".repeat(600)}`,
      requestId: `request-${"y".repeat(220)}`,
      details: { contentType: "application/json", size: 147 },
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());

    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(params[8]).toHaveLength(500);
    expect(params[8]).not.toContain("\n");
    expect(params[9]).toHaveLength(200);
    expect(params[10]).toBe(JSON.stringify({ contentType: "application/json", size: 147 }));
  });

  it("parameterizes filters and returns stable pagination", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "7", details: {} }], rowCount: 1 });
    const service = new WhatsAppTechnicalLogService({ query } as never);

    const result = await service.list({
      page: 2,
      pageSize: 50,
      level: "error",
      component: "waha",
      outcome: "failed",
      search: "WAHA_%",
    });

    expect(result.pagination).toEqual({ page: 2, pageSize: 50, total: 1 });
    expect(result.data).toEqual([{ id: "7", details: {} }]);
    expect(query.mock.calls[0]?.[0]).toContain("event_code ILIKE $4");
    expect(query.mock.calls[0]?.[1]).toEqual(["error", "waha", "failed", "%WAHA_%%"]);
    expect(query.mock.calls[1]?.[1]).toEqual(["error", "waha", "failed", "%WAHA_%%", 50, 50]);
  });
});
