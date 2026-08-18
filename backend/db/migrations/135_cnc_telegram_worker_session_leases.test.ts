import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./135_cnc_telegram_worker_session_leases.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('135 CNC Telegram worker session leases migration', () => {
  it('creates one fenced lease row per configured chat lane', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_telegram_worker_session_leases');
    expect(sql).toContain('source_chat_id TEXT PRIMARY KEY');
    expect(sql).toContain('lease_token TEXT NOT NULL');
    expect(sql).toContain('lease_generation BIGINT NOT NULL');
    expect(sql).toContain('worker_instance_id UUID NOT NULL');
    expect(sql).toContain('worker_image_revision TEXT NOT NULL');
    expect(sql).toContain('heartbeat_at TIMESTAMPTZ NOT NULL');
    expect(sql).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(sql).toContain('chk_cnc_tg_session_lease_expiry');
    expect(sql).toContain("worker_image_revision ~ '^[0-9a-f]{7,64}$'");
    expect(sql).toContain('idx_cnc_tg_session_leases_expiry');
    expect(sql).toContain("SET status='pending', claimed_at=NULL");
    expect(sql).toContain("SET status='unknown'");
    expect(sql).toContain("WHERE status='processing' AND lease_token IS NULL");
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('135_cnc_telegram_worker_session_leases*) probe_all');
    expect(runner).toContain('q_tbl cnc_telegram_worker_session_leases');
    expect(runner).toContain('q_con_on cnc_telegram_worker_session_leases chk_cnc_tg_session_lease_expiry');
    expect(runner).toContain('q_idx idx_cnc_tg_session_leases_expiry');
    expect(runner).toContain('q_con_on cnc_telegram_media_restore_requests chk_cnc_tg_restore_item_lease_shape');
    expect(runner).toContain('q_idx idx_cnc_tg_restore_item_lease_expiry');
    expect(runner).toContain('q_con_on cnc_manual_svg_telegram_send_requests chk_cnc_tg_send_item_lease_shape');
    expect(runner).toContain('q_idx idx_cnc_tg_send_item_lease_expiry');
  });
});
