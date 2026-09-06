import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(__dirname, '147_bitrix24_payment_widget.sql'), 'utf8');

describe('147 Bitrix24 payment widget migration', () => {
  it('creates durable widget, install, catalog, and command storage', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bitrix24_app_install_attempt/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bitrix24_widget_session/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bitrix24_manual_payment_command/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bitrix24_pay_system_catalog/i);
  });

  it('closes the non-idempotent remote-create window without blocking later payments', () => {
    expect(sql).toMatch(/remote_create_started_at/i);
    expect(sql).toMatch(/lease_token\s+UUID/i);
    expect(sql).toMatch(/uq_bitrix24_manual_payment_remote_create/i);
    expect(sql).toMatch(/WHERE status IN \(\s*'processing','pre_create_saved','remote_create_started','remote_create_ambiguous'/i);
  });

  it('preserves date-only and deferred command identity', () => {
    expect(sql).toMatch(/payment_local_date DATE/i);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Almaty'/i);
    expect(sql).toMatch(/manual_command_id UUID/i);
    expect(sql).toMatch(/expected_order_version\s+INTEGER/i);
    expect(sql).toMatch(/uq_bitrix24_request_payment_manual_command/i);
  });

  it('adds widget-specific financial permissions', () => {
    expect(sql).toContain('bitrix24.payments.create');
    expect(sql).toContain('bitrix24.payments.confirm_overpayment');
  });
});
