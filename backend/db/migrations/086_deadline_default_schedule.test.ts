import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('086_deadline_default_schedule migration', () => {
  const sql = readFileSync(
    resolve(__dirname, '086_deadline_default_schedule.sql'),
    'utf8',
  );
  const runner = readFileSync(
    resolve(__dirname, '../../../ops/apply-migrations.sh'),
    'utf8',
  );

  it('creates singleton config with bounded reserve and version', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS deadline_default_schedule_config/i);
    expect(sql).toMatch(/CHECK\s*\(\s*config_id = 1\s*\)/i);
    expect(sql).toMatch(/reserve_days BETWEEN 0 AND 3650/i);
    expect(sql).toMatch(/INSERT INTO deadline_default_schedule_config/i);
    expect(sql).toMatch(/ON CONFLICT \(config_id\) DO NOTHING/i);
  });

  it('stores one bounded duration per production status', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS deadline_default_stage_durations/i);
    expect(sql).toMatch(/production_status_id SMALLINT PRIMARY KEY/i);
    expect(sql).toMatch(
      /FOREIGN KEY \(production_status_id\)[\s\S]*REFERENCES production_statuses\(production_status_id\) ON DELETE RESTRICT/i,
    );
    expect(sql).toMatch(/position INTEGER NOT NULL/i);
    expect(sql).toMatch(/UNIQUE \(position\)/i);
    expect(sql).toMatch(/duration_days BETWEEN 0 AND 3650/i);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toMatch(/086_deadline_default_schedule\*\)/);
    expect(runner).toMatch(/q_tbl deadline_default_schedule_config/);
    expect(runner).toMatch(/q_con uq_deadline_default_stage_position/);
    expect(runner).toMatch(/q_con chk_deadline_default_schedule_version/);
    expect(runner).toMatch(/q_con fk_deadline_default_stage_production_status/);
    expect(runner).toMatch(
      /FROM deadline_default_schedule_config[\s\S]*config_id = 1[\s\S]*version > 0/,
    );
  });
});
