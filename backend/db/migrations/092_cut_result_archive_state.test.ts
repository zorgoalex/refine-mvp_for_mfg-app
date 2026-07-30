import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./092_cut_result_archive_state.sql', import.meta.url), 'utf8');

describe('092 cut result archive state migration', () => {
  it('stores mutable archive state outside immutable cut_result ledger', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cut_result_archive_state/i);
    expect(sql).toMatch(/PRIMARY KEY \(cut_job_id, result_no\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(cut_job_id\) REFERENCES cut_job\(cut_job_id\)/i);
    expect(sql).toMatch(/archived_by BIGINT REFERENCES users\(user_id\)/i);
    expect(sql).not.toMatch(/ALTER TABLE cut_result/i);
  });
});
