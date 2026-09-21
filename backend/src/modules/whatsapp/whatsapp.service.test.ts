import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../common/errors/api-error";
import {
  WhatsAppService,
  parseInbound,
  privateIdentifier,
  restrictionDetails,
  verifyWebhook,
} from "./whatsapp.service";

function statusService(options: { session?: string; cappingError?: boolean } = {}) {
  const resolved = vi.fn().mockResolvedValue({ ok: true });
  const record = vi.fn().mockResolvedValue(undefined);
  const client = {
    health: resolved,
    version: resolved,
    serverStatus: resolved,
    session: vi.fn().mockResolvedValue({ status: options.session ?? "WORKING" }),
    me: resolved,
    capping: options.cappingError
      ? vi.fn().mockRejectedValue(new ApiError(502, "WAHA_PROVIDER_ERROR", "provider"))
      : resolved,
    timelock: resolved,
  };
  const service = new WhatsAppService(
    { getConfig: () => ({ enabled: true }) } as never,
    { diagnostics: resolved } as never,
    client as never,
    {} as never,
    { record } as never,
  );
  return { service, record };
}

describe("WhatsApp webhook boundary", () => {
  it("verifies the exact WAHA raw-body HMAC and timestamp headers", () => {
    const body = Buffer.from('{"event":"message"}');
    const secret = "s".repeat(32);
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    expect(() =>
      verifyWebhook(body, signature, "sha512", String(Date.now()), secret)
    ).not.toThrow();
    expect(() =>
      verifyWebhook(
        Buffer.from('{"event":"other"}'),
        signature,
        "sha512",
        String(Date.now()),
        secret
      )
    ).toThrow(/signature/i);
  });

  it("rejects stale, missing, and downgraded signatures", () => {
    const body = Buffer.from("{}");
    const secret = "s".repeat(32);
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    expect(() =>
      verifyWebhook(body, signature, "sha256", String(Date.now()), secret)
    ).toThrow(/algorithm/i);
    expect(() =>
      verifyWebhook(
        body,
        signature,
        "sha512",
        String(Date.now() - 600_000),
        secret
      )
    ).toThrow(/timestamp/i);
    expect(() =>
      verifyWebhook(body, undefined, "sha512", String(Date.now()), secret)
    ).toThrow(/signature/i);
  });

  it("accepts only inbound direct text from the configured session", () => {
    expect(
      parseInbound(
        {
          event: "message",
          session: "default",
          payload: {
            id: { _serialized: "msg-1" },
            from: "77001234567@c.us",
            body: " Цена ",
            fromMe: false,
            hasMedia: false,
            type: "text",
          },
        },
        "default",
        "request-1"
      )
    ).toEqual({
      kind: "message",
      message: {
        externalEventId: "msg-1",
        sessionName: "default",
        chatId: "77001234567@c.us",
        text: "Цена",
        requestId: "request-1",
      },
    });
    expect(
      parseInbound(
        {
          event: "message",
          session: "default",
          payload: {
            id: "msg-2",
            from: "group@g.us",
            body: "test",
            hasMedia: false,
          },
        },
        "default",
        "request-2"
      )
    ).toMatchObject({ kind: "ignored", reason: "non_direct_chat" });
    expect(() =>
      parseInbound(
        { event: "message", session: "other", payload: {} },
        "default",
        "request-3"
      )
    ).toThrow(/session/i);
  });

  it("accepts GOWS LID chats and normalizes internal WhatsApp user IDs", () => {
    const payload = {
      event: "message",
      session: "default",
      payload: {
        id: "message-1",
        body: "цена",
        fromMe: false,
        hasMedia: false,
      },
    };

    expect(parseInbound({
      ...payload,
      payload: { ...payload.payload, from: "123456789@lid" },
    }, "default", "request-lid")).toMatchObject({
      kind: "message",
      message: { chatId: "123456789@lid" },
    });
    expect(parseInbound({
      ...payload,
      payload: { ...payload.payload, from: "77001234567@s.whatsapp.net" },
    }, "default", "request-internal")).toMatchObject({
      kind: "message",
      message: { chatId: "77001234567@c.us" },
    });
  });

  it("records ignored webhooks in the redacted technical journal", async () => {
    const secret = "s".repeat(32);
    const body = Buffer.from(JSON.stringify({
      event: "message",
      session: "default",
      payload: {
        id: "private-message-id",
        from: "private-group@g.us",
        body: "private body",
        fromMe: false,
        hasMedia: false,
      },
    }));
    const signature = createHmac("sha512", secret).update(body).digest("hex");
    const record = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [{ audit_id: "audit-1" }] });
    const service = new WhatsAppService(
      { getConfig: () => ({ enabled: true, webhookSecret: secret, sessionName: "default" }) } as never,
      {} as never,
      {} as never,
      { query } as never,
      { record } as never,
    );

    await expect(service.webhook(
      body,
      signature,
      "sha512",
      String(Date.now()),
      "request-ignored",
    )).resolves.toEqual({ accepted: true, result: "ignored" });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      component: "webhook",
      eventCode: "whatsapp.webhook.ignored",
      details: { reason: "non_direct_chat" },
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-message-id");
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-group");
    expect(JSON.stringify(record.mock.calls)).not.toContain("private body");
  });

  it("rejects media captions, edits, reactions, and locations", () => {
    const base = {
      id: "false_77001234567@c.us_ABC",
      from: "77001234567@c.us",
      body: "цена",
      hasMedia: false,
    };
    expect(
      parseInbound(
        { event: "message", session: "default", payload: { ...base, hasMedia: true } },
        "default",
        "r1"
      )
    ).toMatchObject({ kind: "ignored", reason: "non_text_message" });
    expect(
      parseInbound(
        { event: "message", session: "default", payload: { ...base, type: "location", latitude: 1 } },
        "default",
        "r2"
      )
    ).toMatchObject({ kind: "ignored", reason: "non_text_message" });
    expect(parseInbound({ event: "message.edited", session: "default", payload: base }, "default", "r3"))
      .toMatchObject({ kind: "ignored", reason: "event" });
    expect(parseInbound({ event: "message.reaction", session: "default", payload: base }, "default", "r4"))
      .toMatchObject({ kind: "ignored", reason: "event" });
  });

  it("turns realistic WAHA IDs containing JIDs into stable private identifiers", () => {
    const raw = "false_77001234567@c.us_A1B2C3";
    const hashed = privateIdentifier("s".repeat(32), raw);
    expect(hashed).toMatch(/^h1:[a-f0-9]{64}$/);
    expect(hashed).not.toContain("@c.us");
    expect(privateIdentifier("s".repeat(32), raw)).toBe(hashed);
  });

  it("surfaces capping and timelock restrictions", () => {
    expect(
      restrictionDetails({
        capping: { cappingStatus: "CAPPED" },
        timelock: { isActive: true },
      })
    ).toEqual(["message_capping", "reachout_timelock"]);
  });
});

describe("WhatsApp status diagnostics", () => {
  it("marks partial provider failures as degraded and exposes their safe code", async () => {
    const { service } = statusService({ cappingError: true });
    const result = await service.status();
    expect(result.degraded).toBe(true);
    expect(result.issues.capping).toBe("WAHA_PROVIDER_ERROR");
  });

  it.each([
    ["FAILED", "error"],
    ["STOPPED", "warn"],
    ["UNKNOWN", "warn"],
  ])("logs degraded session %s with level %s", async (session, level) => {
    const fixture = statusService({ session });
    const result = await fixture.service.status();
    expect(result.degraded).toBe(true);
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: "waha.session.snapshot",
      level,
      details: { status: session },
    }));
  });
});
