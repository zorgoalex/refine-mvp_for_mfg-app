import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./056_projects.sql', import.meta.url), 'utf8');

describe('056_projects migration', () => {
  it('creates projects with unique citext code and composite unique', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS projects/i);
    expect(sql).toMatch(/code\s+CITEXT\s+NOT NULL/i);
    expect(sql).toMatch(/uq_projects_code UNIQUE \(code\)/i);
    expect(sql).toMatch(/uq_projects_id_client UNIQUE \(project_id, client_id\)/i);
  });

  it('backfills one project per order then enforces NOT NULL composite FK', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS project_id BIGINT/i);
    expect(sql).toMatch(/WHERE o\.project_id IS NULL/i);
    expect(sql).toMatch(/ALTER COLUMN project_id SET NOT NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(project_id, client_id\)/i);
    expect(sql).toMatch(/setval\(pg_get_serial_sequence\('public\.projects'/i);
  });

  it('rebuilds orders_view with computed full number and creates projects_view', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW orders_view/i);
    expect(sql).toMatch(/AS order_full_number/i);
    expect(sql).toMatch(/AS project_code/i);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW projects_view/i);
  });
});
