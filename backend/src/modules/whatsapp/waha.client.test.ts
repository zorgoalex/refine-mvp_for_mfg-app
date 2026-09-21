import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "./waha.client";
import type { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";

const config = {
  enabled: true,
  baseUrl: "http://waha:3000",
  apiKey: "a".repeat(32),
  sessionName: "erp",
  webhookSecret: "b".repeat(32),
  requestTimeoutMs: 1000,
  relayOwner: "none" as const,
  relayPollIntervalMs: 10000,
  relayBatchSize: 20,
  relayWorkerId: "test",
  relayMaxAttempts: 5,
  relayStaleLockMs: 600000,
  cleanupOwner: "in_process" as const,
};

describe("WahaClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only allowlisted text fields with the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "provider-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient({ getConfig: () => config } as WhatsAppRuntimeConfigService);
    await expect(client.sendText("7700@c.us", "Ответ")).resolves.toEqual({ messageId: "provider-1" });
    expect(fetchMock).toHaveBeenCalledWith("http://waha:3000/api/sendText", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Api-Key": config.apiKey }),
      body: JSON.stringify({ session: "erp", chatId: "7700@c.us", text: "Ответ" }),
    }));
  });

  it("uses the WAHA 2026 session routes for capping and timelock", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient({ getConfig: () => config } as WhatsAppRuntimeConfigService);

    await client.capping();
    await client.timelock();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://waha:3000/api/sessions/erp/capping",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://waha:3000/api/sessions/erp/timelock",
      expect.any(Object),
    );
  });

  it("does not leak provider response details through errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret provider body", { status: 500 })));
    const client = new WahaClient({ getConfig: () => config } as WhatsAppRuntimeConfigService);
    await expect(client.health()).rejects.toMatchObject({
      code: "WAHA_PROVIDER_ERROR",
      message: expect.not.stringContaining("secret provider body"),
    });
  });

  it("records a redacted technical event for a provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private body", { status: 500 })));
    const record = vi.fn().mockResolvedValue(undefined);
    const client = new WahaClient(
      { getConfig: () => config } as WhatsAppRuntimeConfigService,
      { record } as never,
    );
    await expect(client.qr()).rejects.toMatchObject({ code: "WAHA_PROVIDER_ERROR" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      component: "waha",
      level: "error",
      operation: "GET /api/{session}/auth/qr?format=image",
      httpStatus: 500,
      errorCode: "WAHA_PROVIDER_ERROR",
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private body");
    expect(JSON.stringify(record.mock.calls)).not.toContain(config.apiKey);
  });

  it("requests QR bytes as PNG instead of provider JSON", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(png, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient({ getConfig: () => config } as WhatsAppRuntimeConfigService);

    const result = await client.qr();

    expect(result.contentType).toBe("image/png");
    expect(Array.from(result.bytes)).toEqual(Array.from(png));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://waha:3000/api/erp/auth/qr?format=image",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "image/png" }) }),
    );
  });

  it("rejects a JSON QR response instead of passing a broken image to the browser", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ mimetype: "image/png", data: "secret" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const record = vi.fn().mockResolvedValue(undefined);
    const client = new WahaClient(
      { getConfig: () => config } as WhatsAppRuntimeConfigService,
      { record } as never,
    );

    await expect(client.qr()).rejects.toMatchObject({ code: "WAHA_QR_RESPONSE_INVALID", statusCode: 502 });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "WAHA_QR_RESPONSE_INVALID",
      details: expect.objectContaining({ contentType: "application/json" }),
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("secret");
  });
});
