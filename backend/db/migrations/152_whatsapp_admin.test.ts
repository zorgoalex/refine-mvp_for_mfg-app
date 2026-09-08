import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(__dirname, "152_whatsapp_admin.sql"), "utf8");

describe("migration 152 WhatsApp administration", () => {
  it("creates deduplicated inbound events and a leased delivery queue", () => {
    expect(sql).toMatch(/external_event_id text NOT NULL UNIQUE/i);
    expect(sql).toMatch(/idempotency_key text NOT NULL UNIQUE/i);
    expect(sql).toMatch(/lock_token uuid/i);
    expect(sql).toMatch(/send_started_at timestamptz/i);
    expect(sql).toMatch(/state IN \('pending','processing','retry_wait','sent','failed','unknown'\)/i);
  });

  it("bounds raw text retention and marks manage permission dangerous", () => {
    expect(sql).toMatch(/text_expires_at[\s\S]*interval '30 days'/i);
    expect(sql).toMatch(/body_expires_at[\s\S]*interval '30 days'/i);
    expect(sql).toMatch(/'whatsapp\.manage'[\s\S]*191, true, true/i);
    expect(sql).toMatch(/role_code IN \('admin','superadmin'\)/i);
  });
});
