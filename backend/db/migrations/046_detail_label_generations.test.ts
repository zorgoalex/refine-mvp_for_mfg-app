import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./046_detail_label_generations.sql', import.meta.url), 'utf8');

describe('046 detail label generations migration', () => {
  it('allows orderless detail-batch label generations with explicit scope metadata', () => {
    expect(sql).toMatch(/ALTER TABLE order_label_generations\s+ALTER COLUMN order_id DROP NOT NULL/i);
    expect(sql).toMatch(/generation_scope TEXT NOT NULL DEFAULT 'order'/i);
    expect(sql).toMatch(/scope_json JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
    expect(sql).toMatch(/generation_scope IN \('order', 'details'\)/i);
    expect(sql).toMatch(/idx_order_label_generations_scope_generated_at/i);
  });
});
