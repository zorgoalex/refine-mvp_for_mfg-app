import { describe, expect, it } from "vitest";
import { parseWhatsAppTechnicalLogQuery } from "./whatsapp-technical-log.dto";

describe("parseWhatsAppTechnicalLogQuery", () => {
  it("applies bounded pagination defaults and coerces query strings", () => {
    expect(parseWhatsAppTechnicalLogQuery({})).toEqual({ page: 1, pageSize: 100 });
    expect(parseWhatsAppTechnicalLogQuery({ page: "2", pageSize: "200", level: "error" }))
      .toEqual({ page: 2, pageSize: 200, level: "error" });
  });

  it.each([
    { page: "0" },
    { pageSize: "201" },
    { level: "debug" },
    { component: "docker" },
    { outcome: "unknown" },
    { search: "x".repeat(121) },
    { unexpected: "value" },
  ])("rejects invalid filters: %o", (query) => {
    expect(() => parseWhatsAppTechnicalLogQuery(query)).toThrowError(
      expect.objectContaining({ code: "INVALID_WHATSAPP_TECHNICAL_LOG_QUERY" }),
    );
  });
});
