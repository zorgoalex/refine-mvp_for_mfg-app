import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("WhatsApp raw-body boundary", () => {
  it("mounts the narrow raw parser before the global JSON parser", () => {
    const source = readFileSync(resolve(__dirname, "../../main.ts"), "utf8");
    const rawParser = source.indexOf("/whatsapp/webhook");
    const globalJsonParser = source.indexOf("app.use(json({ limit: '50mb' }))");
    expect(rawParser).toBeGreaterThan(-1);
    expect(globalJsonParser).toBeGreaterThan(rawParser);
    expect(source).toContain("raw({ type: 'application/json', limit: '256kb' })");
  });
});
