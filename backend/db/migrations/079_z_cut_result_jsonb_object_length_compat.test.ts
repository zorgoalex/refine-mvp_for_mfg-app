import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./079_z_cut_result_jsonb_object_length_compat.sql', import.meta.url), 'utf8');

describe('079_z cut-result JSON object length compatibility', () => {
  it('defines the immutable helper required by migration 080', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION jsonb_object_length\(p_value JSONB\)/i);
    expect(sql).toMatch(/FROM jsonb_object_keys\(p_value\)/i);
    expect(sql).toMatch(/IMMUTABLE[\s\S]*STRICT[\s\S]*PARALLEL SAFE/i);
  });
});
