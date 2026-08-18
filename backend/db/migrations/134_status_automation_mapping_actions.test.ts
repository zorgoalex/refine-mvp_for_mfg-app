import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./134_status_automation_mapping_actions.sql', import.meta.url), 'utf8');

describe('134_status_automation_mapping_actions migration', () => {
  it('stores mapping config and allows rules without a single target', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS action_config_json jsonb NOT NULL DEFAULT '\{\}'::jsonb/i);
    expect(sql).toMatch(/ALTER COLUMN target_status_id DROP NOT NULL/i);
  });

  it('allows both mapping action types', () => {
    expect(sql).toContain('map_order_status_to_details_production_status');
    expect(sql).toContain('map_production_status_to_order_status');
  });
});
