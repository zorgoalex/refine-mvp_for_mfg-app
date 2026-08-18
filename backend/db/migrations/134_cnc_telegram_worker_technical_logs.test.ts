import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./134_cnc_telegram_worker_technical_logs.sql', import.meta.url), 'utf8');

describe('134 CNC Telegram worker technical logs migration', () => {
  it('creates an idempotent raw log table with evidence and lookup indexes', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_telegram_worker_technical_logs');
    expect(sql).toMatch(/UNIQUE \(worker_instance_id, sequence\)/i);
    expect(sql).toMatch(/stream IN \('stdout', 'stderr'\)/i);
    expect(sql).toContain('redaction_version TEXT NOT NULL');
    expect(sql).toContain('redaction_categories TEXT[] NOT NULL');
    expect(sql).toContain('dropped_before INTEGER NOT NULL');
    expect(sql).toContain('writer_user_id BIGINT NOT NULL REFERENCES users');
    expect(sql).toContain('batch_id UUID NOT NULL');
    expect(sql).toContain('idx_cnc_tg_technical_observed');
    expect(sql).toContain('idx_cnc_tg_technical_instance_observed');
  });

  it('adds a distinct dangerous permission for raw technical logs', () => {
    expect(sql).toContain("'audit.technical.view'");
    expect(sql).toMatch(/role_code IN \('admin', 'superadmin'\)/i);
    expect(sql).toMatch(/is_dangerous[\s\S]*true/i);
  });
});
