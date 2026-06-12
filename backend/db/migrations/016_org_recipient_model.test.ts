import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./016_org_recipient_model.sql', import.meta.url), 'utf8');

describe('016_org_recipient_model migration', () => {
  it('creates the five org tables additively', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS directions/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS direction_workshops/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS direction_work_centers/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS workshop_heads/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS direction_heads/i);
  });

  it('references workshops/work_centers/users by their real keys', () => {
    expect(sql).toMatch(/REFERENCES workshops\(workshop_id\)/i);
    expect(sql).toMatch(/REFERENCES work_centers\(workcenter_id\)/i);
    expect(sql).toMatch(/REFERENCES users\(user_id\)/i);
    expect(sql).toMatch(/REFERENCES directions\(direction_id\)/i);
  });

  it('adds resolution-path indexes', () => {
    expect(sql).toMatch(/idx_direction_workshops_workshop_id/i);
    expect(sql).toMatch(/idx_direction_work_centers_workcenter_id/i);
    expect(sql).toMatch(/idx_workshop_heads_workshop_id/i);
    expect(sql).toMatch(/idx_direction_heads_direction_id/i);
  });

  it('is additive: no ALTER/DROP of existing engine or order tables', () => {
    expect(sql).not.toMatch(/ALTER TABLE (public\.)?workshops/i);
    expect(sql).not.toMatch(/ALTER TABLE (public\.)?order_workshops/i);
    expect(sql).not.toMatch(/ALTER TABLE (public\.)?notification_rules/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
