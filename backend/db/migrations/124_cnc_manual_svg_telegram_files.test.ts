import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./124_cnc_manual_svg_telegram_files.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('124_cnc_manual_svg_telegram_files migration', () => {
  it('creates DB-retained upload files with one-month expiry and order links', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_manual_svg_upload_files');
    expect(sql).toContain("file_kind IN ('svg', 'gcode', 'screenshot')");
    expect(sql).toContain("expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'");
    expect(sql).toContain('uq_cnc_manual_svg_upload_files_packet_kind');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_manual_svg_upload_file_orders');
    expect(sql).toContain('REFERENCES orders(order_id) ON DELETE CASCADE');
  });

  it('creates an idempotent active Telegram send queue with request-file ordering', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_manual_svg_telegram_send_requests');
    expect(sql).toContain("status IN ('pending', 'processing', 'sent', 'failed', 'unknown')");
    expect(sql).toContain('send_idempotency_key TEXT NOT NULL');
    expect(sql).toContain('attempt_count BETWEEN 0 AND 5');
    expect(sql).toContain('uq_cnc_manual_svg_telegram_send_idempotency_key');
    expect(sql).toContain('uq_cnc_manual_svg_telegram_send_active_packet');
    expect(sql).toContain("WHERE status = 'pending'");
    expect(sql).toContain("status = 'unknown'");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_manual_svg_telegram_send_request_files');
    expect(sql).toContain('UNIQUE (request_id, send_order)');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('124_cnc_manual_svg_telegram_files*) probe_all');
    expect(runner).toContain('q_tbl cnc_manual_svg_upload_files');
    expect(runner).toContain('q_tbl cnc_manual_svg_telegram_send_requests');
  });
});
