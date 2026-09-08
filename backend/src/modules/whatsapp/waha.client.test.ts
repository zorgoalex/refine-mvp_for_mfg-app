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

  it("does not leak provider response details through errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret provider body", { status: 500 })));
    const client = new WahaClient({ getConfig: () => config } as WhatsAppRuntimeConfigService);
    await expect(client.health()).rejects.toMatchObject({
      code: "WAHA_PROVIDER_ERROR",
      message: expect.not.stringContaining("secret provider body"),
    });
  });
});
