import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./001_backend_stage1_additive.sql', import.meta.url),
  'utf8',
);

describe('backend stage 1 additive migration', () => {
  it('adds required audit, upload, integration, and session tables', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS auth_sessions/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS file_uploads/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS integration_jobs/i);
  });

  it('hardens refresh_tokens for rotation and reuse detection', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS session_id UUID/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS token_family_id UUID/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS replaced_by_token_id UUID/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS reuse_detected_at TIMESTAMPTZ/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS revoked_reason TEXT/i);
  });

  it('adds stable codes and order/resource invariants without destructive type changes', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_code/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS payment_status_code VARCHAR\(64\)/i);
    expect(migration).toMatch(/chk_orders_final_amount_consistent/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_active_material/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_active_film/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_active_edge/i);
    expect(migration).not.toMatch(/ALTER TABLE\s+order_resource_requirements\s+ALTER COLUMN/i);
    expect(migration).not.toMatch(/ALTER TABLE\s+material_unit_conversions\s+ALTER COLUMN/i);
  });
});
