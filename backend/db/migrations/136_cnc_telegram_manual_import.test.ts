import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./136_cnc_telegram_manual_import.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('136 explicit Telegram import migration', () => {
  it('defines bounded scans, candidates, duplicate matches, requests and item leases', () => {
    for (const table of [
      'cnc_telegram_import_scans',
      'cnc_telegram_import_candidates',
      'cnc_telegram_import_candidate_matches',
      'cnc_telegram_import_requests',
      'cnc_telegram_import_items',
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('date_to <= date_from + 30');
    expect(sql).toContain('uq_cnc_tg_import_request_active_selection');
    expect(sql).toContain('source_set_fingerprint');
    expect(sql).toContain('workday DATE NOT NULL');
    expect(sql).toContain('duplicate_acknowledged');
    expect(sql).toContain('lease_generation');
    expect(sql).toContain('cnc.telegram_import.manage_all');
  });

  it('has an effect probe for every Phase B relation and permission', () => {
    expect(runner).toContain('136_cnc_telegram_manual_import*) probe_all');
    for (const table of [
      'cnc_telegram_import_scans',
      'cnc_telegram_import_candidates',
      'cnc_telegram_import_candidate_matches',
      'cnc_telegram_import_requests',
      'cnc_telegram_import_items',
    ]) expect(runner).toContain(`q_tbl ${table}`);
    expect(runner).toContain('cnc.telegram_import.manage_all');
  });
});
