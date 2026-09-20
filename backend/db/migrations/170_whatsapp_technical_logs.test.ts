import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(__dirname, "170_whatsapp_technical_logs.sql"), "utf8");

describe("migration 170 WhatsApp technical logs", () => {
  it("stores bounded, searchable metadata without message payload columns", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS whatsapp_technical_logs/i);
    expect(sql).toMatch(/component IN \('backend','waha','webhook','relay','cleanup'\)/i);
    expect(sql).toMatch(/error_message[\s\S]*char_length\(error_message\) <= 500/i);
    expect(sql).toMatch(/details jsonb[\s\S]*jsonb_typeof\(details\) = 'object'/i);
    expect(sql).not.toMatch(/message_text|chat_id|destination|body text/i);
  });
});
