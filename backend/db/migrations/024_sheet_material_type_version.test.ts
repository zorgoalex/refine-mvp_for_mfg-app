import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./024_sheet_material_type_version.sql', import.meta.url), 'utf8');

describe('024_sheet_material_type_version migration', () => {
  it('adds an optimistic version column to sheet_material_types (additive, idempotent)', () => {
    expect(sql).toMatch(
      /ALTER TABLE sheet_material_types\s+ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0/i,
    );
  });

  it('is additive: no DROP / no table recreation', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });
});
