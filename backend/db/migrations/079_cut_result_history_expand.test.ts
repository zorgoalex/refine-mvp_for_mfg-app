import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./079_cut_result_history_expand.sql', import.meta.url), 'utf8');

describe('079 cut result history expand migration', () => {
  it('adds per-job numbering, immutable snapshot storage, and command ledger', () => {
    expect(sql).toContain('UNIQUE (cut_job_id, result_no)');
    expect(sql).toContain('snapshot_job           JSONB');
    expect(sql).toContain('next_cut_result_no INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cut_result_command');
    expect(sql).toContain('lease_expires_at');
    expect(sql).toContain('claimed_job_version');
    expect(sql).toContain('fk_cut_result_command_payload');
    expect(sql).toContain('FOREIGN KEY (cut_job_id, command_id, command_payload_hash)');
    expect(sql).toContain('cut_result_snapshot_digest');
    expect(sql).toContain("digest(p_snapshot::text, 'sha256')");
  });

  it('keeps expand snapshot columns nullable for application backfill', () => {
    expect(sql).not.toMatch(/snapshot_job\s+JSONB\s+NOT NULL/i);
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  });
});
