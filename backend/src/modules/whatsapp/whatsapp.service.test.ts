import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseInbound,
  privateIdentifier,
  restrictionDetails,
  verifyWebhook,
} from "./whatsapp.service";

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
